const { unsupportedReason, countNodes } = require('./compatibility');
const { analyzeFunction, countReferences, scoreCandidate } = require('./function_classifier');

const DEFAULT_BUDGETS = {
    selected: {
        maxVmInstructions: 1200,
        maxOutputBytes: 750000,
        maxProcessingTimeMs: 1200,
        maxInterpreterInstances: 12
    },
    aggressive: {
        maxVmInstructions: 6000,
        maxOutputBytes: 2500000,
        maxProcessingTimeMs: 2500,
        maxInterpreterInstances: 64
    }
};

const getLimits = (mode, budgets = {}) => ({
    maxNodes: mode === 'aggressive' ? 180 : 90,
    budgets: { ...(DEFAULT_BUDGETS[mode] || DEFAULT_BUDGETS.selected), ...budgets }
});

const memberName = (node) => {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name;
    if (node.type !== 'MemberExpression') return null;
    const base = memberName(node.base) || 'expression';
    return `${base}${node.indexer || '.'}${node.identifier?.name || 'member'}`;
};

const collectRootLocals = (ast) => {
    const names = new Set();
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'FunctionDeclaration') {
            if (node.isLocal && node.identifier?.type === 'Identifier') names.add(node.identifier.name);
            return;
        }
        if (node.type === 'LocalStatement') {
            for (const variable of node.variables || []) {
                if (variable.type === 'Identifier') names.add(variable.name);
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object' && value.type) visit(value);
        }
    };
    visit(ast);
    return names;
};

const collectOwnBindings = (fnNode) => {
    const names = new Set((fnNode.parameters || [])
        .filter(param => param.type === 'Identifier')
        .map(param => param.name));
    if (fnNode.identifier?.type === 'MemberExpression' && fnNode.identifier.indexer === ':') names.add('self');
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node !== fnNode && node.type === 'FunctionDeclaration') {
            if (node.isLocal && node.identifier?.type === 'Identifier') names.add(node.identifier.name);
            return;
        }
        if (node.type === 'LocalStatement') {
            for (const variable of node.variables || []) {
                if (variable.type === 'Identifier') names.add(variable.name);
            }
        }
        if (node.type === 'ForNumericStatement' && node.variable?.type === 'Identifier') names.add(node.variable.name);
        if (node.type === 'ForGenericStatement') {
            for (const variable of node.variables || []) {
                if (variable.type === 'Identifier') names.add(variable.name);
            }
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object' && value.type) visit(value);
        }
    };
    visit(fnNode);
    return names;
};

const collectFunctionCandidates = (ast, rootLocals) => {
    const candidates = [];
    let anonymousIndex = 0;
    const visit = (node, outerBindings, parentFunction = null, parentNode = null, parentKey = '') => {
        if (!node || typeof node !== 'object') return;
        let childBindings = outerBindings;
        let currentFunction = parentFunction;
        if (node.type === 'FunctionDeclaration') {
            const isNamedLocal = node.isLocal && node.identifier?.type === 'Identifier';
            const isAnonymous = !node.identifier;
            const isNonLocal = !node.isLocal && (node.identifier?.type === 'Identifier'
                || node.identifier?.type === 'MemberExpression');
            const name = isNamedLocal
                ? node.identifier.name
                : (isAnonymous
                    ? `anonymous_callback_${++anonymousIndex}`
                    : (memberName(node.identifier) || `function_${candidates.length + 1}`));
            currentFunction = {
                node,
                name,
                isNamedLocal,
                isAnonymous,
                isNonLocal,
                parentFunction,
                parentNode,
                parentKey,
                outerBindings: new Set(outerBindings),
                ownBindings: collectOwnBindings(node),
                upvalues: []
            };
            candidates.push(currentFunction);
            childBindings = new Set(outerBindings);
            for (const binding of currentFunction.ownBindings) childBindings.add(binding);
        }
        for (const [key, value] of Object.entries(node)) {
            if (Array.isArray(value)) value.forEach(item => visit(item, childBindings, currentFunction, node, key));
            else if (value && typeof value === 'object' && value.type) visit(value, childBindings, currentFunction, node, key);
        }
    };
    visit(ast, rootLocals);
    return candidates;
};

const findCapturedRootLocals = (fnNode, rootLocals) => {
    const declared = collectOwnBindings(fnNode);

    const captured = new Set();
    const inspect = (node, parent = null, key = '') => {
        if (!node || typeof node !== 'object') return;
        if (node !== fnNode && node.type === 'FunctionDeclaration') return;
        if (node.type === 'Identifier') {
            const declaration = (parent?.type === 'FunctionDeclaration' && (key === 'identifier' || key === 'parameters'))
                || (parent?.type === 'LocalStatement' && key === 'variables')
                || (parent?.type === 'MemberExpression' && key === 'identifier')
                || (parent?.type === 'TableKeyString' && key === 'key');
            if (!declaration && !declared.has(node.name) && rootLocals.has(node.name)) captured.add(node.name);
            return;
        }
        for (const [childKey, value] of Object.entries(node)) {
            if (Array.isArray(value)) value.forEach(item => inspect(item, node, childKey));
            else if (value && typeof value === 'object' && value.type) inspect(value, node, childKey);
        }
    };
    inspect(fnNode);
    return [...captured];
};

const resolveCandidateUpvalues = (candidates) => {
    for (const candidate of candidates) {
        candidate.upvalues = findCapturedRootLocals(candidate.node, candidate.outerBindings);
    }

    // A nested prototype may capture a binding owned by an ancestor rather than
    // its immediate parent. Make every intermediate prototype carry that cell.
    for (let index = candidates.length - 1; index >= 0; index--) {
        const child = candidates[index];
        const parent = child.parentFunction;
        if (!parent) continue;
        for (const upvalue of child.upvalues) {
            if (parent.ownBindings.has(upvalue)) continue;
            if (!parent.outerBindings.has(upvalue)) continue;
            if (!parent.upvalues.includes(upvalue)) parent.upvalues.push(upvalue);
        }
    }

    for (const candidate of candidates) {
        Object.defineProperty(candidate.node, '_vmUpvalues', {
            value: candidate.upvalues,
            configurable: true
        });
    }
};

const selectFunctions = (ast, options = {}) => {
    const mode = options.vmMode || 'off';
    const limits = getLimits(mode, options.budgets);
    const selected = [];
    const skipped = [];
    const rootLocals = collectRootLocals(ast);
    const candidates = collectFunctionCandidates(ast, rootLocals);
    resolveCandidateUpvalues(candidates);
    const namedCandidates = candidates.filter(candidate => candidate.isNamedLocal).map(candidate => candidate.name);
    const references = countReferences(ast, namedCandidates);
    let eligibleFunctions = 0;
    let eligibleAstNodes = 0;

    for (const candidate of candidates) {
        candidate.nodeCount = countNodes(candidate.node);
        candidate.analysis = analyzeFunction(candidate.node, candidate);
        Object.assign(candidate, scoreCandidate(candidate, references.get(candidate.name) || 0));
    }

    if (mode === 'off') {
        return { selected, skipped, limits, candidates, discoveredFunctions: candidates.length, eligibleFunctions, eligibleAstNodes };
    }

    for (const candidate of candidates) {
        const { node, name, isAnonymous } = candidate;
        const reason = unsupportedReason(node, { ...limits, allowAnonymous: isAnonymous });
        candidate.reason = reason;
        if (reason) {
            skipped.push({ name, node, reason, nodeCount: candidate.nodeCount, sourceRange: node.loc || node.range || null, isAnonymous, eligible: false });
            if (options.strict) {
                const error = new Error(`SukaRed VM error: ${name}: ${reason}`);
                error.stage = 'vm-selection';
                throw error;
            }
            continue;
        }
        eligibleFunctions += 1;
        eligibleAstNodes += candidate.nodeCount;
        Object.defineProperty(node, '_vmName', { value: name, configurable: true });
    }

    const eligibleCandidates = candidates.filter(candidate => !candidate.reason);
    const units = eligibleCandidates.filter(candidate => !candidate.parentFunction || candidate.parentFunction.reason);
    const unitSet = new Set(units);
    const membersByUnit = new Map(units.map(unit => [unit, []]));
    for (const candidate of eligibleCandidates) {
        let root = candidate;
        while (root.parentFunction && !root.parentFunction.reason) root = root.parentFunction;
        if (unitSet.has(root)) membersByUnit.get(root).push(candidate);
    }
    const rankedUnits = units.map(unit => {
        const members = membersByUnit.get(unit);
        const estimatedInstructions = Math.max(1, Math.ceil(unit.nodeCount * 0.65));
        const estimatedOutputBytes = estimatedInstructions * 220;
        const protectionValue = members.reduce((total, candidate) => total + candidate.protectionValueScore, 0);
        return {
            unit,
            members,
            estimatedInstructions,
            estimatedOutputBytes,
            protectionValue,
            score: protectionValue / estimatedInstructions
        };
    }).sort((left, right) => right.score - left.score || right.unit.nodeCount - left.unit.nodeCount);

    const usage = { instructions: 0, outputBytes: 0, interpreterInstances: 0 };
    const budget = limits.budgets;
    for (const ranked of rankedUnits) {
        let budgetReason = null;
        if (usage.instructions + ranked.estimatedInstructions > budget.maxVmInstructions) budgetReason = 'budget:maxVmInstructions';
        else if (usage.outputBytes + ranked.estimatedOutputBytes > budget.maxOutputBytes) budgetReason = 'budget:maxOutputBytes';
        else if (!options.hell
            && usage.interpreterInstances + ranked.members.length > budget.maxInterpreterInstances) {
            budgetReason = 'budget:maxInterpreterInstances';
        }

        if (budgetReason) {
            for (const candidate of ranked.members) {
                skipped.push({
                    name: candidate.name,
                    node: candidate.node,
                    reason: budgetReason,
                    nodeCount: candidate.nodeCount,
                    sourceRange: candidate.node.loc || candidate.node.range || null,
                    isAnonymous: candidate.isAnonymous,
                    eligible: true
                });
            }
            continue;
        }
        usage.instructions += ranked.estimatedInstructions;
        usage.outputBytes += ranked.estimatedOutputBytes;
        usage.interpreterInstances += options.hell ? 0 : ranked.members.length;
        ranked.members.forEach(candidate => selected.push(candidate.node));
        ranked.members.forEach(candidate => { candidate.selected = true; });
    }

    return {
        selected,
        skipped,
        limits,
        candidates,
        budgetUsage: usage,
        discoveredFunctions: candidates.length,
        eligibleFunctions,
        eligibleAstNodes
    };
};

module.exports = { selectFunctions, getLimits };
