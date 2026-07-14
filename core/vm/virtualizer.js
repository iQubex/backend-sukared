const { parse, astToCode } = require('../ast_traverser');
const { compileFunctionToIr } = require('./compiler');
const { createOpcodeMap, makeRng, shuffleWithSeed } = require('./opcode_generator');
const { generateInterpreter, INTERPRETER_FAMILIES } = require('./interpreter_generator');
const { selectFunctions } = require('./function_selector');
const { emptyVmMetrics } = require('./metrics');
const { CLUSTER_FAMILIES, assignClusters, generateCluster } = require('./cluster_generator');

const rawExpression = (raw) => ({ type: 'RawExpression', raw });
const rawStatement = (raw) => ({ type: 'RawStatement', raw });

const containsNode = (parent, child) => parent !== child
    && Array.isArray(parent.range)
    && Array.isArray(child.range)
    && parent.range[0] <= child.range[0]
    && parent.range[1] >= child.range[1];

const countPrototypeTree = (ir) => (ir.prototypes || []).reduce(
    (total, prototype) => total + 1 + countPrototypeTree(prototype), 0);

const countInstructions = (ir) => ir.instructions.length
    + (ir.prototypes || []).reduce((total, prototype) => total + countInstructions(prototype), 0);

const countCapturedUpvalues = (ir) => (ir.upvalues || []).length
    + (ir.prototypes || []).reduce((total, prototype) => total + countCapturedUpvalues(prototype), 0);

const countConstantTree = (ir) => {
    const nested = (ir.prototypes || []).map(countConstantTree);
    return {
        total: ir.constants.length + nested.reduce((sum, item) => sum + item.total, 0),
        strings: ir.constants.filter(value => typeof value === 'string').length
            + nested.reduce((sum, item) => sum + item.strings, 0),
        segments: (ir.constants.length > 0 ? 1 : 0)
            + nested.reduce((sum, item) => sum + item.segments, 0)
    };
};
const prototypeTreeHasConstants = (ir, values) => {
    const constants = new Set();
    const collect = current => {
        current.constants.forEach(value => constants.add(value));
        (current.prototypes || []).forEach(collect);
    };
    collect(ir);
    return values.every(value => constants.has(value));
};

const recordInterpreterTree = (metrics, ir, generated, fallbackName, nested = false) => {
    const functionName = ir.name || fallbackName;
    metrics.branchOrders.push(generated.branchOrder);
    metrics.interpreterTemplates.push(generated.interpreterTemplate);
    metrics.constantPoolStrategies.push(generated.constantPoolStrategy);
    metrics.operandEncodings.push(generated.operandEncoding);
    metrics.shuffledBlockCount += generated.shuffledBlockCount || 0;
    metrics.fusedInstructionCount += generated.fusedInstructionCount || 0;
    metrics.splitInstructionCount += generated.splitInstructionCount || 0;
    metrics.blockOrders.push(generated.blockOrder || []);
    metrics.instructionLayouts.push({
        function: functionName,
        nested,
        layout: generated.layout,
        fieldOrder: generated.fieldOrder
    });
    metrics.functions.push({
        name: functionName,
        status: 'virtualized',
        nested,
            instructionCount: ir.instructions.length,
            blockOrder: generated.blockOrder,
        layout: generated.layout,
        fieldOrder: generated.fieldOrder,
        interpreterTemplate: generated.interpreterTemplate,
        ir: ir.instructions,
        constants: ir.constants,
        bytecode: generated.bytecode,
        branchOrder: generated.branchOrder
    });
    (ir.prototypes || []).forEach((prototype, index) => recordInterpreterTree(
        metrics,
        prototype,
        generated.nested[index],
        `${functionName}::prototype_${index + 1}`,
        true
    ));
};

const replaceWithVmClosure = (node, closureSource) => {
    const identifier = node.identifier;
    const name = identifier?.type === 'Identifier' ? identifier.name : null;
    const isLocal = node.isLocal === true;
    for (const key of Object.keys(node)) delete node[key];
    if (name && isLocal) {
        Object.assign(node, {
            type: 'LocalStatement',
            variables: [{ type: 'Identifier', name }],
            init: [rawExpression(closureSource)]
        });
    } else if (identifier) {
        const target = identifier.type === 'MemberExpression'
            ? { ...identifier, indexer: '.' }
            : identifier;
        Object.assign(node, {
            type: 'AssignmentStatement',
            variables: [target],
            init: [rawExpression(closureSource)]
        });
    } else {
        Object.assign(node, rawExpression(closureSource));
    }
};

const clusterEntryExpression = (clusterName, entryAccess, entryId, ir) => {
    const cells = (ir.upvalues || []).map(upvalue => {
        const target = upvalue === ir.selfName ? '__hell_self' : upvalue;
        return `{function() return ${target} end,function(value) ${target}=value end}`;
    }).join(',');
    return `(function() local __hell_self;__hell_self=${clusterName}${entryAccess}(${entryId},{${cells}});return __hell_self end)()`;
};

const virtualizeSource = async (source, options = {}) => {
    const vmStarted = Date.now();
    const vmMode = options.vmMode || 'off';
    const metrics = emptyVmMetrics(vmMode);
    const ast = parse(source, 'vm-input');
    if (vmMode === 'off') {
        const selection = selectFunctions(ast, { vmMode: 'off', publicProfile: options.publicProfile });
        metrics.discoveredFunctions = selection.discoveredFunctions;
        metrics.discoveredFunctionCandidates = selection.discoveredFunctions;
        metrics.fallbackFunctions = selection.discoveredFunctions;
        metrics.nonVmCompatibleFunctions = selection.discoveredFunctions;
        metrics.yieldSensitiveFunctions = selection.candidates.filter(candidate => candidate.analysis?.yieldSensitive).length;
        metrics.environmentSensitiveFunctions = selection.candidates.filter(candidate => candidate.analysis?.environmentSensitive).length;
        metrics.selectionDetails = selection.candidates.map(candidate => ({
            function: candidate.name,
            callback: candidate.isAnonymous,
            classification: candidate.analysis?.yieldSensitive
                ? 'coroutine/yield sensitive'
                : (candidate.analysis?.environmentSensitive ? 'environment sensitive' : 'non-VM compatible'),
            selected: false,
            virtualized: false,
            fallback: true,
            fallbackReason: 'profile VM disabled',
            protectionValueScore: candidate.protectionValueScore,
            estimatedVmCost: candidate.estimatedVmCost,
            selectionReason: candidate.selectionReason
        }));
        return { code: source, metrics };
    }

    const opcodeMap = createOpcodeMap(options.seed || `${Date.now()}:${Math.random()}`);
    metrics.opcodeMap = opcodeMap;
    const selection = selectFunctions(ast, {
        vmMode,
        strict: options.strict === true,
        budgets: options.budgets,
        hell: options.hell === true,
        publicProfile: options.publicProfile,
        maxClusterSize: options.maxClusterSize
    });
    metrics.selectedFunctions = selection.selected.length;
    metrics.nestedFunctionsDiscovered = selection.selected.filter(node =>
        selection.selected.some(parent => containsNode(parent, node))).length;
    metrics.nestedFunctionsSelected = metrics.nestedFunctionsDiscovered;
    metrics.discoveredFunctions = selection.discoveredFunctions;
    metrics.discoveredFunctionCandidates = selection.discoveredFunctions;
    metrics.eligibleFunctions = selection.eligibleFunctions;
    metrics.eligibleAstNodes = selection.eligibleAstNodes;
    metrics.yieldSensitiveFunctions = selection.candidates.filter(candidate => candidate.analysis?.yieldSensitive).length;
    metrics.environmentSensitiveFunctions = selection.candidates.filter(candidate => candidate.analysis?.environmentSensitive).length;
    metrics.dedicatedInterpreterRequiredFunctions = selection.candidates.filter(candidate =>
        candidate.analysis?.yieldSensitive || (candidate.parentFunction && candidate.upvalues.length > 0)).length;
    metrics.skippedFunctions = selection.skipped.length;
    for (const skipped of selection.skipped) {
        metrics.functions.push({
            name: skipped.name,
            status: `skipped: ${skipped.reason}`,
            instructionCount: 0,
            sourceRange: skipped.sourceRange || null
        });
        if (/FunctionDeclaration/.test(skipped.reason)) metrics.functionDeclarationSkips += 1;
    }
    const virtualizedCandidates = new Set();
    const budgetLimitedCandidates = new Set(selection.skipped
        .filter(item => item.eligible && String(item.reason).startsWith('budget:'))
        .map(item => selection.candidates.find(candidate => candidate.node === item.node || candidate.name === item.name))
        .filter(Boolean));
    const unsupportedCandidates = new Set(selection.candidates.filter(candidate => candidate.reason));

    if (selection.selected.length === 0) {
        metrics.eligibleSkippedFunctions = metrics.eligibleFunctions;
        metrics.excludedFunctions = metrics.discoveredFunctionCandidates;
        metrics.excludedCallbacks = selection.candidates.filter(candidate => candidate.isAnonymous).length;
        metrics.budgetLimitedFunctions = [...budgetLimitedCandidates].filter(candidate => !candidate.isAnonymous).length;
        metrics.budgetLimitedCallbacks = [...budgetLimitedCandidates].filter(candidate => candidate.isAnonymous).length;
        metrics.unsupportedFunctions = [...unsupportedCandidates].filter(candidate => !candidate.isAnonymous).length;
        metrics.unsupportedCallbacks = [...unsupportedCandidates].filter(candidate => candidate.isAnonymous).length;
        metrics.skippedFunctions = metrics.excludedFunctions;
        metrics.fallbackFunctions = metrics.discoveredFunctionCandidates;
        metrics.nonVmCompatibleFunctions = Math.max(0,
            metrics.fallbackFunctions - metrics.unsupportedFunctions - metrics.unsupportedCallbacks);
        metrics.selectionDetails = selection.candidates.map(candidate => {
            const skipped = selection.skipped.find(item => item.node === candidate.node);
            const budgetLimited = String(skipped?.reason || '').startsWith('budget:');
            const classification = candidate.reason
                ? 'unsupported syntax'
                : (budgetLimited
                    ? 'over profile budget'
                    : (candidate.analysis?.yieldSensitive
                        ? 'coroutine/yield sensitive'
                        : (candidate.analysis?.environmentSensitive ? 'environment sensitive' : 'non-VM compatible')));
            return {
                function: candidate.name,
                callback: candidate.isAnonymous,
                classification,
                selected: false,
                virtualized: false,
                fallback: true,
                fallbackReason: skipped?.reason || 'safe non-VM fallback',
                protectionValueScore: candidate.protectionValueScore,
                estimatedVmCost: candidate.estimatedVmCost,
                selectionReason: candidate.selectionReason
            };
        });
        metrics.fallbackCategoryCounts = metrics.selectionDetails.reduce((counts, item) => {
            counts[item.classification] = (counts[item.classification] || 0) + 1;
            return counts;
        }, {});
        return {
            code: source,
            metrics
        };
    }

    const selectedNodeSet = new Set(selection.selected);
    const candidateByNode = new Map(selection.candidates.map(candidate => [candidate.node, candidate]));
    const emittedSelections = selection.selected.filter(node => {
        let parent = candidateByNode.get(node)?.parentFunction;
        while (parent) {
            if (selectedNodeSet.has(parent.node)) return false;
            parent = parent.parentFunction;
        }
        return true;
    });
    const emittedNodeSet = new Set(emittedSelections);
    const affectedCandidatesByNode = new Map(emittedSelections.map(node => [node, []]));
    for (const candidate of selection.candidates) {
        if (!selectedNodeSet.has(candidate.node)) continue;
        let root = candidate;
        while (root.parentFunction && selectedNodeSet.has(root.parentFunction.node)) root = root.parentFunction;
        if (emittedNodeSet.has(root.node)) affectedCandidatesByNode.get(root.node).push(candidate);
    }
    let generatedOutputBytes = 0;
    let generatedInterpreterInstances = 0;
    const clusteredNodes = new Set();
    const budgetRejectedNodes = new Set();
    if (options.hell === true) {
        const compiledEntries = [];
        for (const node of emittedSelections) {
            try {
                const ir = compileFunctionToIr(node, { maxNodes: selection.limits.maxNodes });
                const hasYieldBoundary = prototypeTreeHasConstants(ir, ['coroutine', 'yield']);
                if (!hasYieldBoundary) {
                    const affectedCandidates = affectedCandidatesByNode.get(node) || [];
                    compiledEntries.push({
                        node,
                        ir,
                        affectedCandidates,
                        name: node._vmName || node.identifier?.name || `cluster_function_${compiledEntries.length + 1}`
                    });
                } else metrics.clusterFallbackReasons.push({
                    function: node._vmName || node.identifier?.name || 'anonymous',
                    reason: hasYieldBoundary
                        ? 'coroutine.yield requires dedicated interpreter'
                        : 'unsafe prototype graph requires dedicated interpreter'
                });
                if (hasYieldBoundary && (ir.prototypes || []).length) metrics.prototypeFallbackReasons.push({
                    function: node._vmName || node.identifier?.name || 'anonymous',
                    reason: 'prototype graph crosses coroutine.yield boundary'
                });
            } catch (_) {
                // The dedicated path below retains the existing safe fallback.
            }
        }
        const planned = assignClusters(compiledEntries, options.seed || 'hell', options.maxClusterSize || 6);
        const sharedClusters = planned.filter(cluster => cluster.length >= 2);
        const clusterFamilyDeck = shuffleWithSeed(CLUSTER_FAMILIES, `cluster-family-deck:${options.seed || 'hell'}`);
        for (let clusterIndex = 0; clusterIndex < sharedClusters.length; clusterIndex++) {
            const cluster = sharedClusters[clusterIndex];
            const clusterName = `__hell_cluster_${clusterIndex + 1}_${String(options.seed || 'seed').replace(/[^A-Za-z0-9_]/g, '').slice(0, 8)}`;
            const budget = selection.limits.budgets;
            const estimatedInstructions = cluster.reduce((total, entry) => total + countInstructions(entry.ir), 0);
            const estimatedOutputBytes = estimatedInstructions * 210;
            let preflightReason = null;
            if (metrics.vmInstructionCount + estimatedInstructions > budget.maxVmInstructions) {
                preflightReason = 'budget:maxVmInstructions';
            } else if (generatedOutputBytes + estimatedOutputBytes > budget.maxOutputBytes) {
                preflightReason = 'budget:maxOutputBytes';
            } else if (generatedInterpreterInstances + 1 > budget.maxInterpreterInstances) {
                preflightReason = 'budget:maxInterpreterInstances';
            } else if (Date.now() - vmStarted > budget.maxProcessingTimeMs) {
                preflightReason = 'budget:maxProcessingTimeMs';
            }
            if (preflightReason) {
                for (const entry of cluster) {
                    budgetRejectedNodes.add(entry.node);
                    metrics.clusterFallbackReasons.push({ function: entry.name, reason: `${preflightReason}; generation skipped by preflight` });
                    for (const candidate of entry.affectedCandidates) {
                        budgetLimitedCandidates.add(candidate);
                        metrics.functions.push({
                            name: candidate.name,
                            status: `skipped: ${preflightReason}`,
                            instructionCount: 0,
                            sourceRange: candidate.node.loc || candidate.node.range || null
                        });
                    }
                }
                continue;
            }
            const generated = generateCluster(cluster, `${options.seed || 'hell'}:${clusterIndex}`, {
                family: clusterFamilyDeck[clusterIndex % clusterFamilyDeck.length]
            });
            const clusterOutputBytes = Buffer.byteLength(generated.source, 'utf8');
            let clusterBudgetReason = null;
            if (metrics.vmInstructionCount + generated.metrics.instructionCount > budget.maxVmInstructions) {
                clusterBudgetReason = 'budget:maxVmInstructions';
            } else if (generatedOutputBytes + clusterOutputBytes > budget.maxOutputBytes) {
                clusterBudgetReason = 'budget:maxOutputBytes';
            } else if (generatedInterpreterInstances + 1 > budget.maxInterpreterInstances) {
                clusterBudgetReason = 'budget:maxInterpreterInstances';
            } else if (Date.now() - vmStarted > budget.maxProcessingTimeMs) {
                clusterBudgetReason = 'budget:maxProcessingTimeMs';
            }
            if (clusterBudgetReason) {
                for (const entry of cluster) metrics.clusterFallbackReasons.push({
                    function: entry.name,
                    reason: `${clusterBudgetReason}; dedicated budget path used`
                });
                continue;
            }
            ast.body.unshift(rawStatement(`local ${clusterName}=${generated.source}`));
            cluster.forEach((entry, entryIndex) => {
                replaceWithVmClosure(entry.node, clusterEntryExpression(clusterName, generated.entryAccess, entryIndex + 1, entry.ir));
                clusteredNodes.add(entry.node);
                entry.affectedCandidates.forEach(candidate => virtualizedCandidates.add(candidate));
                metrics.virtualizedAstNodes += entry.affectedCandidates.reduce((total, candidate) => total + candidate.nodeCount, 0);
                metrics.functions.push({
                    name: entry.name,
                    status: 'virtualized',
                    nested: false,
                    clustered: true,
                    cluster: clusterIndex + 1,
                    instructionCount: entry.ir.instructions.length,
                    layout: 'table',
                    fieldOrder: ['cluster-specific'],
                    interpreterTemplate: generated.interpreterTemplate,
                    ir: entry.ir.instructions
                });
                metrics.instructionLayouts.push({
                    function: entry.name,
                    nested: false,
                    clustered: true,
                    cluster: clusterIndex + 1,
                    layout: 'table',
                    fieldOrder: ['cluster-specific']
                });
                for (const candidate of entry.affectedCandidates) {
                    if (candidate.node === entry.node) continue;
                    metrics.functions.push({
                        name: candidate.name,
                        status: 'virtualized',
                        nested: true,
                        clustered: true,
                        cluster: clusterIndex + 1,
                        instructionCount: 0,
                        interpreterTemplate: 'cluster-local-prototype-v2'
                    });
                    metrics.instructionLayouts.push({
                        function: candidate.name,
                        nested: true,
                        clustered: true,
                        cluster: clusterIndex + 1,
                        layout: 'prototype-factory',
                        fieldOrder: ['function-specific']
                    });
                }
            });
            metrics.sharedInterpreterClusters += 1;
            metrics.clusteredFunctions += generated.metrics.clusteredFunctions;
            metrics.clusteredPrototypeFunctions += generated.metrics.clusteredPrototypeFunctions;
            metrics.constantPoolSegments += generated.metrics.constantPoolSegments;
            metrics.clusterConstantSegments += generated.metrics.clusterConstantSegments;
            metrics.functionLocalConstantSegments += generated.metrics.functionLocalConstantSegments;
            metrics.sharedConstantCount += generated.metrics.sharedConstantCount;
            metrics.functionLocalConstantCount += generated.metrics.functionLocalConstantCount;
            metrics.lazyConstantCount += generated.metrics.lazyConstantCount;
            metrics.decodedAtStartupCount += generated.metrics.decodedAtStartupCount;
            metrics.totalProtectedConstants += generated.metrics.totalProtectedConstants;
            metrics.fusedInstructionCount += generated.metrics.fusedInstructionCount;
            metrics.splitInstructionCount += generated.metrics.splitInstructionCount;
            metrics.fusedOpcodeFamilies.push(...generated.metrics.fusedOpcodeFamilies);
            metrics.splitOpcodeFamilies.push(...generated.metrics.splitOpcodeFamilies);
            metrics.shuffledBlockCount += generated.metrics.shuffledBlockCount;
            metrics.cfgInvertedBranches += generated.metrics.invertedBranches;
            metrics.cfgRewrittenJumpChains += generated.metrics.rewrittenJumpChains;
            metrics.invertedBranchCount += generated.metrics.invertedBranches;
            metrics.rewrittenJumpCount += generated.metrics.rewrittenJumpChains;
            metrics.splitBlockCount += generated.metrics.splitBlockCount;
            metrics.mergedBlockCount += generated.metrics.mergedBlockCount;
            metrics.temporaryRegisterCount += generated.metrics.temporaryRegisterCount;
            metrics.dispatchFamiliesUsed.push(generated.metrics.dispatchFamily);
            metrics.fetchFamiliesUsed.push(generated.metrics.fetchFamily);
            metrics.callFamiliesUsed.push(generated.metrics.callFamily);
            metrics.callFamiliesUsed.push(generated.metrics.entryFamily);
            metrics.constantDecoderFamilies.push(generated.metrics.constantDecoderFamily);
            metrics.constantCacheCount += generated.metrics.constantCacheCount;
            metrics.fakeOpcodeCount += generated.metrics.fakeOpcodeCount;
            metrics.fakeHandlerCount += generated.metrics.fakeHandlerCount;
            metrics.opcodeAliasCount += generated.metrics.opcodeAliasCount;
            metrics.cfgVariants.push(generated.metrics.cfgVariant);
            metrics.dispatcherBlocks += generated.metrics.dispatcherBlocks;
            metrics.helperBlocks += generated.metrics.helperBlocks;
            metrics.deadStateCount += generated.metrics.deadStateCount;
            metrics.fakeTransitionCount += generated.metrics.fakeTransitionCount;
            metrics.transitionStructureCount += generated.metrics.transitionStructureCount || 0;
            metrics.validatedPhysicalPcFunctions += generated.metrics.validatedPhysicalPcFunctions || 0;
            metrics.physicalBranchTargetCount += generated.metrics.physicalBranchTargetCount || 0;
            metrics.physicalBackwardEdgeCount += generated.metrics.physicalBackwardEdgeCount || 0;
            metrics.vmInstructionCount += generated.metrics.instructionCount;
            metrics.branchOrders.push(generated.metrics.branchOrder);
            metrics.interpreterTemplates.push(generated.interpreterTemplate);
            generatedOutputBytes += clusterOutputBytes;
            generatedInterpreterInstances += 1;
        }
        metrics.averageFunctionsPerCluster = metrics.sharedInterpreterClusters
            ? Number((metrics.clusteredFunctions / metrics.sharedInterpreterClusters).toFixed(2)) : 0;
        metrics.largestClusterSize = sharedClusters.reduce((largest, cluster) => Math.max(largest, cluster.length), 0);
        for (const entry of compiledEntries) {
            if (!clusteredNodes.has(entry.node)) metrics.clusterFallbackReasons.push({
                function: entry.name,
                reason: 'cluster assignment produced a singleton; dedicated interpreter used'
            });
        }
    }
    const familyRng = makeRng(`family:${options.seed || 'seed'}`);
    const familyOffset = Math.floor(familyRng() * INTERPRETER_FAMILIES.length);
    const dedicatedSelections = emittedSelections.filter(node =>
        !clusteredNodes.has(node) && !budgetRejectedNodes.has(node));
    for (let i = 0; i < dedicatedSelections.length; i++) {
        const fn = dedicatedSelections[i];
        const affectedCandidates = affectedCandidatesByNode.get(fn) || [];
        try {
            const ir = compileFunctionToIr(fn, { maxNodes: selection.limits.maxNodes });
            const budget = selection.limits.budgets;
            const estimatedInstructions = countInstructions(ir);
            const estimatedOutputBytes = estimatedInstructions * 260;
            let preflightReason = null;
            if (metrics.vmInstructionCount + estimatedInstructions > budget.maxVmInstructions) {
                preflightReason = 'budget:maxVmInstructions';
            } else if (generatedOutputBytes + estimatedOutputBytes > budget.maxOutputBytes) {
                preflightReason = 'budget:maxOutputBytes';
            } else if (generatedInterpreterInstances + 1 + countPrototypeTree(ir) > budget.maxInterpreterInstances) {
                preflightReason = 'budget:maxInterpreterInstances';
            } else if (Date.now() - vmStarted > budget.maxProcessingTimeMs) {
                preflightReason = 'budget:maxProcessingTimeMs';
            }
            if (preflightReason) {
                for (const candidate of affectedCandidates) {
                    budgetLimitedCandidates.add(candidate);
                    metrics.functions.push({
                        name: candidate.name,
                        status: `skipped: ${preflightReason}`,
                        instructionCount: 0,
                        sourceRange: candidate.node.loc || candidate.node.range || null
                    });
                }
                continue;
            }
            const functionName = fn._vmName || fn.identifier?.name || `anonymous_callback_${i + 1}`;
            const functionSeed = `${options.seed || 'seed'}:${functionName}:${i}`;
            const rng = makeRng(`layout:${functionSeed}`);
            const layouts = ['flat', 'table', 'segmented'];
            const family = INTERPRETER_FAMILIES[(i + familyOffset) % INTERPRETER_FAMILIES.length];
            const familyLayout = {
                'handler-table-v1': 'table',
                'segmented-state-v1': 'segmented',
                'hybrid-dispatch-v1': 'flat'
            }[family];
            const layout = familyLayout || layouts[Math.floor(rng() * layouts.length)];
            const fieldOrder = shuffleWithSeed(['op', 'a', 'b', 'c', 'd'], `fields:${functionSeed}`);
            const generated = generateInterpreter({
                ir,
                opcodeMap,
                seed: functionSeed,
                layout,
                fieldOrder,
                family,
                diversify: options.hell === true
            });
            const nextInstructionCount = metrics.vmInstructionCount + generated.encodedInstructionCount;
            const nextOutputBytes = generatedOutputBytes + Buffer.byteLength(generated.source, 'utf8');
            const nextInterpreterInstances = generatedInterpreterInstances + 1 + countPrototypeTree(ir);
            let budgetReason = null;
            if (nextInstructionCount > budget.maxVmInstructions) budgetReason = 'budget:maxVmInstructions';
            else if (nextOutputBytes > budget.maxOutputBytes) budgetReason = 'budget:maxOutputBytes';
            else if (nextInterpreterInstances > budget.maxInterpreterInstances) budgetReason = 'budget:maxInterpreterInstances';
            else if (Date.now() - vmStarted > budget.maxProcessingTimeMs) budgetReason = 'budget:maxProcessingTimeMs';
            if (budgetReason) {
                for (const candidate of affectedCandidates) {
                    budgetLimitedCandidates.add(candidate);
                    metrics.functions.push({
                        name: candidate.name,
                        status: `skipped: ${budgetReason}`,
                        instructionCount: 0,
                        sourceRange: candidate.node.loc || candidate.node.range || null
                    });
                }
                continue;
            }
            replaceWithVmClosure(fn, generated.source);
            const nestedCount = countPrototypeTree(ir);
            affectedCandidates.forEach(candidate => virtualizedCandidates.add(candidate));
            metrics.virtualizedFunctions = virtualizedCandidates.size;
            metrics.nestedFunctionsVirtualized += nestedCount;
            metrics.closuresCreated += nestedCount;
            metrics.capturedUpvalues += countCapturedUpvalues(ir);
            const dedicatedConstants = countConstantTree(ir);
            if (dedicatedConstants.total > 0) {
                metrics.constantPoolSegments += dedicatedConstants.segments;
                metrics.functionLocalConstantSegments += dedicatedConstants.segments;
                metrics.functionLocalConstantCount += dedicatedConstants.total;
                metrics.totalProtectedConstants += dedicatedConstants.total;
                metrics.lazyConstantCount += dedicatedConstants.strings;
            }
            metrics.vmInstructionCount += generated.encodedInstructionCount;
            generatedOutputBytes = nextOutputBytes;
            generatedInterpreterInstances = nextInterpreterInstances;
            metrics.virtualizedAstNodes += affectedCandidates.reduce(
                (total, candidate) => total + candidate.nodeCount,
                0
            );
            recordInterpreterTree(metrics, ir, generated, functionName);
            metrics.dedicatedInterpreterFunctions += 1 + nestedCount;
            metrics.dedicatedPrototypeFunctions += nestedCount;
        } catch (err) {
            for (const candidate of affectedCandidates) {
                unsupportedCandidates.add(candidate);
                metrics.functions.push({
                    name: candidate.name,
                    status: `failed: ${err.reason || err.message}`,
                    instructionCount: 0,
                    sourceRange: candidate.node.loc || candidate.node.range || null
                });
            }
            if (options.strict === true) {
                err.stage = 'vm-compile';
                throw err;
            }
        }
    }

    metrics.virtualizedFunctions = virtualizedCandidates.size;
    metrics.eligibleSkippedFunctions = Math.max(0, metrics.eligibleFunctions - metrics.virtualizedFunctions);
    metrics.excludedFunctions = Math.max(0, metrics.discoveredFunctionCandidates - metrics.virtualizedFunctions);
    metrics.excludedCallbacks = selection.candidates.filter(candidate =>
        candidate.isAnonymous && !virtualizedCandidates.has(candidate)).length;
    metrics.budgetLimitedFunctions = [...budgetLimitedCandidates].filter(candidate => !candidate.isAnonymous).length;
    metrics.budgetLimitedCallbacks = [...budgetLimitedCandidates].filter(candidate => candidate.isAnonymous).length;
    metrics.unsupportedFunctions = [...unsupportedCandidates].filter(candidate => !candidate.isAnonymous).length;
    metrics.unsupportedCallbacks = [...unsupportedCandidates].filter(candidate => candidate.isAnonymous).length;
    metrics.skippedFunctions = metrics.excludedFunctions;
    metrics.fallbackFunctions = Math.max(0, metrics.discoveredFunctionCandidates - metrics.virtualizedFunctions);
    metrics.nonVmCompatibleFunctions = Math.max(0, metrics.fallbackFunctions
        - metrics.unsupportedFunctions - metrics.unsupportedCallbacks
        - metrics.budgetLimitedFunctions - metrics.budgetLimitedCallbacks);
    const selectedNodes = new Set(selection.selected);
    metrics.selectionDetails = selection.candidates.map(candidate => {
        const skipped = selection.skipped.find(item => item.node === candidate.node);
        const budgetLimited = budgetLimitedCandidates.has(candidate);
        const needsDedicated = candidate.analysis?.yieldSensitive
            || (candidate.parentFunction && candidate.upvalues.length > 0);
        return {
            function: candidate.name,
            callback: candidate.isAnonymous,
            classification: candidate.reason
                ? 'unsupported syntax'
                : (budgetLimited
                    ? 'over profile budget'
                    : (candidate.analysis?.yieldSensitive
                        ? 'coroutine/yield sensitive'
                        : (candidate.analysis?.environmentSensitive
                            ? 'environment sensitive'
                            : (needsDedicated ? 'dedicated interpreter required' : (virtualizedCandidates.has(candidate) ? 'VM eligible' : 'non-VM compatible'))))),
            selected: selectedNodes.has(candidate.node),
            virtualized: virtualizedCandidates.has(candidate),
            fallback: !virtualizedCandidates.has(candidate),
            fallbackReason: skipped?.reason || (!virtualizedCandidates.has(candidate) ? 'safe non-VM fallback' : null),
            protectionValueScore: candidate.protectionValueScore,
            estimatedVmCost: candidate.estimatedVmCost,
            selectionReason: candidate.selectionReason
        };
    });
    metrics.fallbackCategoryCounts = metrics.selectionDetails
        .filter(item => item.fallback)
        .reduce((counts, item) => {
            counts[item.classification] = (counts[item.classification] || 0) + 1;
            return counts;
        }, {});

    metrics.functionCoveragePercent = metrics.eligibleFunctions
        ? Number((metrics.virtualizedFunctions / metrics.eligibleFunctions * 100).toFixed(2))
        : 0;
    metrics.astCoveragePercent = metrics.eligibleAstNodes
        ? Number((metrics.virtualizedAstNodes / metrics.eligibleAstNodes * 100).toFixed(2))
        : 0;
    metrics.vmFunctionCount = metrics.virtualizedFunctions;
    metrics.interpreterInstanceCount = options.hell === true
        ? metrics.sharedInterpreterClusters + metrics.dedicatedInterpreterFunctions
        : metrics.instructionLayouts.length;
    metrics.interpreterFamiliesUsed = [...new Set(metrics.interpreterTemplates)];
    metrics.dedicatedInterpreterCount = metrics.dedicatedInterpreterFunctions;
    metrics.sharedInterpreterCount = metrics.sharedInterpreterClusters;
    metrics.fusedOpcodeFamilies = [...new Set(metrics.fusedOpcodeFamilies)];
    metrics.splitOpcodeFamilies = [...new Set(metrics.splitOpcodeFamilies)];
    metrics.dispatchFamiliesUsed = [...new Set(metrics.dispatchFamiliesUsed)];
    metrics.dispatchFamilyCount = metrics.dispatchFamiliesUsed.length;
    metrics.fetchFamiliesUsed = [...new Set(metrics.fetchFamiliesUsed)];
    metrics.callFamiliesUsed = [...new Set(metrics.callFamiliesUsed)];
    metrics.constantDecoderFamilies = [...new Set(metrics.constantDecoderFamilies)];
    metrics.cfgVariants = [...new Set(metrics.cfgVariants)];
    metrics.averageAliasesPerOpcode = metrics.vmInstructionCount
        ? Number((metrics.opcodeAliasCount / Math.max(1, metrics.vmInstructionCount) + 1).toFixed(2)) : 0;
    metrics.nestedVmFunctionCount = metrics.nestedFunctionsVirtualized;

    return {
        code: astToCode(ast),
        metrics
    };
};

module.exports = {
    virtualizeSource
};
