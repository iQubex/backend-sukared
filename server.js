const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const { preprocess } = require('./core/preprocessor');
const { injectDeadCode } = require('./core/dead_code_enjector');
const { transformAst } = require('./core/ast_traverser');
const { attachDecoderRuntime } = require('./utils/braille_cipher');
const { minifyLuau } = require('./core/luau_minifier');
const { createBuildConfig } = require('./core/build_config');
const { analyzeObfuscatedCode } = require('./core/adversarial_analyzer');
const { virtualizeSource } = require('./core/vm/virtualizer');
const { emptyVmMetrics } = require('./core/vm/metrics');
const { validateVmOutput } = require('./core/vm/output_validator');
const { SERVICE_LIMITS } = require('./core/service/config');
const { FixedWindowRateLimiter } = require('./core/service/rate_limiter');
const { CreditLedger } = require('./core/service/credit_ledger');
const { BuildPool } = require('./core/service/build_pool');
const { OperationalTelemetry } = require('./core/service/telemetry');

const app = express();
const PORT = process.env.PORT || 3000;
const PRODUCT_VERSION = 'SukaRed 1.0';
const VALID_PROFILES = new Set(['light', 'balanced', 'strong']);
const VALID_VM_MODES = new Set(['off', 'selected', 'aggressive']);
const PUBLIC_PROFILES = {
    light: { label: 'Light', internalProfile: 'light', vmMode: 'off', available: true, deadCodeProbability: 0 },
    light_plus: {
        label: 'Light+', internalProfile: 'balanced', vmMode: 'off', available: true,
        deadCodeProbability: 0.02, decoderFamilies: ['shift', 'bytes', 'xor']
    },
    good: {
        label: 'Good', internalProfile: 'strong', vmMode: 'selected', available: true,
        deadCodeProbability: 0.08, safeAlphabet: true, decoderFamilies: ['shift', 'bytes', 'xor'],
        vmBudgets: { maxVmInstructions: 1200, maxOutputBytes: 750000, maxProcessingTimeMs: 1200, maxInterpreterInstances: 12 }
    },
    pro: {
        label: 'Pro', status: 'Experimental', internalProfile: 'strong', vmMode: 'aggressive', available: true, deadCodeProbability: 0.14,
        vmBudgets: { maxVmInstructions: 6000, maxOutputBytes: 2500000, maxProcessingTimeMs: 2500, maxInterpreterInstances: 64 }
    },
    hell: {
        label: 'Hell', status: 'Experimental', internalProfile: 'strong', vmMode: 'aggressive', available: false,
        vmBudgets: { maxVmInstructions: 15000, maxOutputBytes: 6000000, maxProcessingTimeMs: 6000, maxInterpreterInstances: 32 },
        maxClusterSize: 16
    },
    blatant: { label: 'Blatant', available: false },
    fatality: { label: 'Fatality', available: false }
};
const isPublicProfileAvailable = name => PUBLIC_PROFILES[name]?.available === true
    || (name === 'hell' && process.env.SUKARED_HELL_TEST === '1');

app.disable('x-powered-by');
app.set('trust proxy', process.env.SUKARED_TRUST_PROXY === '1' ? 1 : false);
app.use(cors());
app.use(express.json({ limit: SERVICE_LIMITS.jsonBodyBytes }));

let buildPool;
const getBuildPool = () => {
    if (!buildPool) buildPool = new BuildPool({
        concurrency: SERVICE_LIMITS.concurrency,
        maxQueueDepth: SERVICE_LIMITS.maxQueueDepth,
        timeoutMs: SERVICE_LIMITS.buildTimeoutMs,
        memoryMb: SERVICE_LIMITS.workerMemoryMb,
        maxOutputBytes: SERVICE_LIMITS.maxOutputBytes
    });
    return buildPool;
};
const ipLimiter = new FixedWindowRateLimiter({
    limit: SERVICE_LIMITS.ipRequestsPerMinute,
    maxEntries: SERVICE_LIMITS.rateLimiterMaxEntries
});
const accountLimiter = new FixedWindowRateLimiter({
    limit: SERVICE_LIMITS.accountRequestsPerMinute,
    maxEntries: SERVICE_LIMITS.rateLimiterMaxEntries
});
const creditLedger = new CreditLedger({
    ttlMs: SERVICE_LIMITS.idempotencyTtlMs,
    maxRecords: SERVICE_LIMITS.idempotencyMaxRecords
});
const telemetry = new OperationalTelemetry();

const PUBLIC_ERRORS = {
    SOURCE_REQUIRED: [400, 'Code is required.'],
    SOURCE_TOO_LARGE: [413, 'Source exceeds the service limit.'],
    INVALID_JSON: [400, 'Request body must be valid JSON.'],
    PROFILE_INVALID: [400, 'Invalid profile.'],
    PROFILE_UNAVAILABLE: [400, 'This profile is not available yet.'],
    RATE_LIMITED: [429, 'Rate limit exceeded.'],
    IDEMPOTENCY_IN_PROGRESS: [409, 'An identical request is already in progress.'],
    IDEMPOTENCY_CAPACITY: [503, 'Build transaction capacity is temporarily exhausted.'],
    QUEUE_FULL: [503, 'Build queue is full. Try again later.'],
    BUILD_TIMEOUT: [504, 'Build timed out. No credits were consumed.'],
    OUTPUT_TOO_LARGE: [422, 'Generated output exceeds the service limit. No credits were consumed.'],
    REQUEST_ABORTED: [499, 'Request was cancelled.'],
    SERVICE_DRAINING: [503, 'Build service is restarting.'],
    WORKER_CRASH: [503, 'Build worker failed. No credits were consumed.'],
    GOOD_VM_NOT_APPLIED: [422, 'Good profile could not apply VM virtualization. No credits were consumed.'],
    HELL_REQUIREMENTS_NOT_SATISFIED: [422, 'Hell profile acceptance requirements were not satisfied.'],
    BUILD_FAILED: [422, 'Build failed. No credits were consumed.']
};
const publicErrorFor = error => {
    const code = PUBLIC_ERRORS[error?.code] ? error.code : 'BUILD_FAILED';
    const [status, message] = PUBLIC_ERRORS[code];
    const payload = { status: 'error', code, message, details: message };
    if (code === 'BUILD_FAILED' && typeof error?.message === 'string') {
        payload.details = error.message.slice(0, 1200);
    }
    if (['BUILD_TIMEOUT', 'OUTPUT_TOO_LARGE'].includes(code)) {
        payload.suggestion = 'Try the Good, Light+, or Light profile.';
    }
    return { status, payload };
};

const normalizeVmMode = (profile, requested) => {
    const value = requested || (profile === 'strong' ? 'selected' : 'off');
    if (!VALID_VM_MODES.has(value)) throw new Error('Invalid VM mode.');
    if (profile === 'light' && value !== 'off') throw new Error('Light profile supports VM Off only.');
    if (profile === 'balanced' && value === 'aggressive') throw new Error('Balanced profile supports VM Off or Selected only.');
    return value;
};

const normalizeOptions = (options = {}) => {
    const publicConfig = PUBLIC_PROFILES[options.profile];
    if (publicConfig && !isPublicProfileAvailable(options.profile)) throw new Error('This profile is not available yet.');
    const profile = publicConfig ? publicConfig.internalProfile : (options.profile || 'balanced');
    if (!VALID_PROFILES.has(profile)) throw new Error('Invalid profile.');
    const legacyVmMode = options.useVm === true || options.vm === true ? 'selected' : undefined;
    return {
        ...options,
        profile,
        publicProfile: publicConfig ? publicConfig.label : ({ light: 'Light', balanced: 'Light+', strong: 'Good' }[profile]),
        publicProfileStatus: publicConfig?.status || 'Stable',
        failClosedVm: false,
        hell: options.hell === true || options.profile === 'hell',
        enforceHellRequirements: options.profile === 'hell',
        vmBudgets: publicConfig?.vmBudgets || options.vmBudgets,
        maxClusterSize: publicConfig?.maxClusterSize || options.maxClusterSize,
        vmMode: publicConfig ? publicConfig.vmMode : normalizeVmMode(profile, options.vmMode || legacyVmMode),
        deadCodeProbability: publicConfig?.deadCodeProbability
            ?? (typeof options.deadCodeProbability === 'number' ? options.deadCodeProbability : undefined),
        digitFree: publicConfig ? false : options.digitFree === true,
        safeAlphabet: publicConfig?.safeAlphabet,
        decoderFamilies: publicConfig?.decoderFamilies,
        vmStrict: publicConfig ? false : options.vmStrict === true
    };
};

const getErrorContext = (code, err) => {
    const match = String(err && err.message || '').match(/\[(\d+):(\d+)\]/);
    if (!match) return '';
    const lineNo = Number(match[1]);
    const colNo = Number(match[2]);
    const lines = String(code || '').split('\n');
    const start = Math.max(1, lineNo - 2);
    const end = Math.min(lines.length, lineNo + 2);
    const excerpt = [];
    for (let line = start; line <= end; line++) {
        const text = lines[line - 1] || '';
        excerpt.push(`${line}: ${text}`);
        if (line === lineNo) excerpt.push(`${line}: ${' '.repeat(Math.max(0, colNo))}^`);
    }
    return excerpt.join(' | ');
};

const obfuscateDetailed = async (source, options = {}) => {
    const started = Date.now();
    const normalized = normalizeOptions(options);
    const build = createBuildConfig(normalized);
    const preprocessed = await preprocess(source);
    const vmResult = await virtualizeSource(preprocessed, {
        vmMode: build.vmMode,
        strict: normalized.vmStrict === true,
        seed: normalized.seed || build.randomId,
        budgets: build.vmBudgets,
        hell: normalized.hell === true,
        publicProfile: normalized.publicProfile,
        maxClusterSize: normalized.maxClusterSize
    });
    const vmMetrics = vmResult.metrics || emptyVmMetrics(build.vmMode);
    const vmRequested = build.vmMode !== 'off';
    const vmApplied = vmRequested
        && vmMetrics.virtualizedFunctions > 0
        && vmMetrics.vmInstructionCount > 0;
    const vmReason = vmApplied
        ? null
        : (vmRequested
            ? (vmMetrics.discoveredFunctions === 0
                ? 'No function declarations were found; VM was not needed.'
                : 'No compatible functions were found.')
            : 'VM was not requested.');
    const skipReasons = vmMetrics.functions
        .filter(fn => /^skipped:|^failed:/.test(fn.status || ''))
        .map(fn => ({
            function: fn.name,
            reason: String(fn.status).replace(/^(skipped|failed):\s*/, ''),
            sourceRange: fn.sourceRange || null
        }));
    const skippedByReason = skipReasons.reduce((summary, item) => {
        summary[item.reason] = (summary[item.reason] || 0) + 1;
        return summary;
    }, {});
    const hellMetadata = {
        sharedInterpreterClusters: vmMetrics.sharedInterpreterClusters,
        clusteredFunctions: vmMetrics.clusteredFunctions,
        dedicatedInterpreterFunctions: vmMetrics.dedicatedInterpreterFunctions,
        averageFunctionsPerCluster: vmMetrics.averageFunctionsPerCluster,
        largestClusterSize: vmMetrics.largestClusterSize,
        constantPoolSegments: vmMetrics.constantPoolSegments,
        clusterConstantSegments: vmMetrics.clusterConstantSegments,
        functionLocalConstantSegments: vmMetrics.functionLocalConstantSegments,
        sharedConstantCount: vmMetrics.sharedConstantCount,
        functionLocalConstantCount: vmMetrics.functionLocalConstantCount,
        lazyConstantCount: vmMetrics.lazyConstantCount,
        decodedAtStartupCount: vmMetrics.decodedAtStartupCount,
        totalProtectedConstants: vmMetrics.totalProtectedConstants,
        clusterFallbackReasons: vmMetrics.clusterFallbackReasons,
        fusedOpcodeFamilies: vmMetrics.fusedOpcodeFamilies,
        splitOpcodeFamilies: vmMetrics.splitOpcodeFamilies,
        cfgInvertedBranches: vmMetrics.cfgInvertedBranches,
        cfgRewrittenJumpChains: vmMetrics.cfgRewrittenJumpChains,
        invertedBranchCount: vmMetrics.invertedBranchCount,
        rewrittenJumpCount: vmMetrics.rewrittenJumpCount,
        splitBlockCount: vmMetrics.splitBlockCount,
        mergedBlockCount: vmMetrics.mergedBlockCount,
        temporaryRegisterCount: vmMetrics.temporaryRegisterCount,
        dispatchFamiliesUsed: vmMetrics.dispatchFamiliesUsed,
        dispatchFamilyCount: vmMetrics.dispatchFamilyCount,
        fakeOpcodeCount: vmMetrics.fakeOpcodeCount,
        fakeHandlerCount: vmMetrics.fakeHandlerCount,
        opcodeAliasCount: vmMetrics.opcodeAliasCount,
        averageAliasesPerOpcode: vmMetrics.averageAliasesPerOpcode,
        fetchFamiliesUsed: vmMetrics.fetchFamiliesUsed,
        constantDecoderFamilies: vmMetrics.constantDecoderFamilies,
        constantCacheCount: vmMetrics.constantCacheCount,
        cfgVariants: vmMetrics.cfgVariants,
        dispatcherBlocks: vmMetrics.dispatcherBlocks,
        helperBlocks: vmMetrics.helperBlocks,
        callFamiliesUsed: vmMetrics.callFamiliesUsed,
        deadStateCount: vmMetrics.deadStateCount,
        fakeTransitionCount: vmMetrics.fakeTransitionCount,
        clusteredPrototypeFunctions: vmMetrics.clusteredPrototypeFunctions,
        dedicatedPrototypeFunctions: vmMetrics.dedicatedPrototypeFunctions,
        prototypeFallbackReasons: vmMetrics.prototypeFallbackReasons
        ,transitionStructureCount: vmMetrics.transitionStructureCount
        ,validatedPhysicalPcFunctions: vmMetrics.validatedPhysicalPcFunctions
        ,physicalBranchTargetCount: vmMetrics.physicalBranchTargetCount
        ,physicalBackwardEdgeCount: vmMetrics.physicalBackwardEdgeCount
        ,completeLogicalMapEmitted: vmMetrics.completeLogicalMapEmitted
    };
    if (normalized.enforceHellRequirements) {
        const blockers = [];
        if (!vmApplied) blockers.push('VM was not applied');
        if (vmMetrics.sharedInterpreterClusters < 1) blockers.push('no shared interpreter cluster');
        if (vmMetrics.clusteredFunctions < 1) blockers.push('no clustered functions');
        if (vmMetrics.constantPoolSegments < 2) blockers.push('constant pools were not segmented');
        if (vmMetrics.lazyConstantCount < 1) blockers.push('lazy constants were not exercised');
        if (vmMetrics.shuffledBlockCount < 1) blockers.push('no physical basic blocks were shuffled');
        if (vmMetrics.fusedInstructionCount < 1) blockers.push('no fused opcode was emitted');
        if (vmMetrics.splitInstructionCount < 1) blockers.push('no split opcode was emitted');
        if (vmMetrics.interpreterFamiliesUsed.length < 2) blockers.push('mixed interpreter families were not emitted');
        if (vmMetrics.clusteredFunctions + vmMetrics.dedicatedInterpreterFunctions !== vmMetrics.virtualizedFunctions) {
            blockers.push('clustered/dedicated function accounting invariant failed');
        }
        if (blockers.length) {
            const error = new Error(`Hell profile requirements were not satisfied.\n${blockers.join('\n')}`);
            error.code = 'HELL_REQUIREMENTS_NOT_SATISFIED';
            error.stage = 'hell-gate';
            error.blockers = blockers;
            throw error;
        }
    }
    if (normalized.failClosedVm && !vmApplied && vmMetrics.discoveredFunctions > 0) {
        const reasonText = skipReasons.length
            ? skipReasons.map(item => `${item.function}: ${item.reason}`).join('; ')
            : 'No local function declarations were discovered.';
        const error = new Error([
            'Good profile could not apply VM virtualization.',
            `Compatible functions: ${vmMetrics.eligibleFunctions}`,
            `Skip reasons: ${reasonText}`
        ].join('\n'));
        error.code = 'GOOD_VM_NOT_APPLIED';
        error.stage = 'vm-coverage';
        error.build = {
            version: PRODUCT_VERSION,
            publicProfile: normalized.publicProfile,
            publicProfileStatus: normalized.publicProfileStatus,
            internalProfile: build.profile,
            vmMode: build.vmMode,
            vmRequested: true,
            vmApplied: false,
            vmReason: 'No compatible functions were found.',
            discoveredFunctions: vmMetrics.discoveredFunctions,
            discoveredFunctionCandidates: vmMetrics.discoveredFunctionCandidates,
            eligibleFunctions: vmMetrics.eligibleFunctions,
            selectedFunctions: vmMetrics.selectedFunctions,
            virtualizedFunctions: vmMetrics.virtualizedFunctions,
            eligibleSkippedFunctions: vmMetrics.eligibleSkippedFunctions,
            excludedFunctions: vmMetrics.excludedFunctions,
            excludedCallbacks: vmMetrics.excludedCallbacks,
            budgetLimitedFunctions: vmMetrics.budgetLimitedFunctions,
            budgetLimitedCallbacks: vmMetrics.budgetLimitedCallbacks,
            unsupportedFunctions: vmMetrics.unsupportedFunctions,
            unsupportedCallbacks: vmMetrics.unsupportedCallbacks,
            vmFunctionCount: vmMetrics.vmFunctionCount,
            interpreterInstanceCount: vmMetrics.interpreterInstanceCount,
            interpreterFamiliesUsed: vmMetrics.interpreterFamiliesUsed,
            sharedInterpreterCount: vmMetrics.sharedInterpreterCount,
            dedicatedInterpreterCount: vmMetrics.dedicatedInterpreterCount,
            fusedInstructionCount: vmMetrics.fusedInstructionCount,
            splitInstructionCount: vmMetrics.splitInstructionCount,
            shuffledBlockCount: vmMetrics.shuffledBlockCount,
            normalizedSimilarity: vmMetrics.normalizedSimilarity,
            blockOrders: vmMetrics.blockOrders,
            nestedVmFunctionCount: vmMetrics.nestedVmFunctionCount,
            skippedFunctions: vmMetrics.skippedFunctions,
            skipReasons,
            skippedByReason,
            vmInstructionCount: vmMetrics.vmInstructionCount,
            interpreterTemplate: null,
            instructionLayout: []
        };
        throw error;
    }
    const withDeadCode = await injectDeadCode(vmResult.code, {
        probability: build.deadCodeProbability,
        digitFree: build.digitFree,
        fingerprint: build.fingerprint
    });
    const vmOutputOwnsRuntime = vmApplied;
    const applyPostVmTransforms = !vmOutputOwnsRuntime;
    const transformed = applyPostVmTransforms
        ? await transformAst(withDeadCode, {
            digitFree: build.digitFree,
            hideNumbers: build.hideNumbers,
            decoderFamilies: build.decoderFamilies,
            inlineStringRate: build.inlineStringRate,
            safeAlphabet: build.safeAlphabet,
            flattenRate: vmOutputOwnsRuntime ? 0 : build.flattenRate
        })
        : {
            code: minifyLuau(withDeadCode),
            hasEncryptedStrings: false,
            report: {
                protectedStringCount: 0,
                decoderFamilyCount: 0,
                decoderFamilies: [],
                uniqueAstFingerprintCount: 0,
                helperCount: 0,
                dependencyGraphSize: 0,
                directDecoderCallRatio: 0,
                dynamicKeyRatio: 0,
                alphabetReuseRatio: 0,
                estimatedAnalysisCost: vmMetrics.vmInstructionCount
            }
        };
    const obfuscated = attachDecoderRuntime(transformed.code, transformed.hasEncryptedStrings);
    const useLegacyPayloadWrapper = false;
    const code = obfuscated;
    const vmStructure = vmApplied ? validateVmOutput(code) : null;
    if (vmApplied && !vmStructure.valid) {
        const error = new Error('Generated VM output validation failed.');
        error.code = 'VM_OUTPUT_INVALID';
        error.stage = 'vm-output-validation';
        throw error;
    }
    const processingTimeMs = Date.now() - started;
    const originalBytes = Buffer.byteLength(String(source || ''), 'utf8');
    const outputBytes = Buffer.byteLength(code, 'utf8');
    const expansionRatio = originalBytes ? Number((outputBytes / originalBytes).toFixed(2)) : 0;
    const publicVmFunctions = vmMetrics.functions.map(fn => ({
        name: fn.name,
        status: fn.status,
        instructionCount: fn.instructionCount,
        layout: fn.layout,
        fieldOrder: fn.fieldOrder,
        interpreterTemplate: fn.interpreterTemplate
    }));
    return {
        code,
        build: {
            version: PRODUCT_VERSION,
            publicProfile: normalized.publicProfile,
            publicProfileStatus: normalized.publicProfileStatus,
            internalProfile: build.profile,
            profile: build.profile,
            vmMode: build.vmMode,
            vmRequested,
            vmApplied,
            vmReason,
            skipReasons,
            skippedByReason,
            buildId: build.fingerprint,
            originalBytes,
            outputBytes,
            expansionRatio,
            processingTimeMs,
            virtualizedFunctions: vmMetrics.virtualizedFunctions,
            vmFunctionCount: vmMetrics.vmFunctionCount,
            interpreterInstanceCount: vmMetrics.interpreterInstanceCount,
            interpreterFamiliesUsed: vmMetrics.interpreterFamiliesUsed,
            sharedInterpreterCount: vmMetrics.sharedInterpreterCount,
            dedicatedInterpreterCount: vmMetrics.dedicatedInterpreterCount,
            fusedInstructionCount: vmMetrics.fusedInstructionCount,
            splitInstructionCount: vmMetrics.splitInstructionCount,
            shuffledBlockCount: vmMetrics.shuffledBlockCount,
            normalizedSimilarity: vmMetrics.normalizedSimilarity,
            blockOrders: vmMetrics.blockOrders,
            nestedVmFunctionCount: vmMetrics.nestedVmFunctionCount,
            protectedStrings: transformed.report.protectedStringCount,
            discoveredFunctions: vmMetrics.discoveredFunctions,
            discoveredFunctionCandidates: vmMetrics.discoveredFunctionCandidates,
            eligibleFunctions: vmMetrics.eligibleFunctions,
            selectedFunctions: vmMetrics.selectedFunctions,
            skippedFunctions: vmMetrics.skippedFunctions,
            eligibleSkippedFunctions: vmMetrics.eligibleSkippedFunctions,
            excludedFunctions: vmMetrics.excludedFunctions,
            excludedCallbacks: vmMetrics.excludedCallbacks,
            budgetLimitedFunctions: vmMetrics.budgetLimitedFunctions,
            budgetLimitedCallbacks: vmMetrics.budgetLimitedCallbacks,
            unsupportedFunctions: vmMetrics.unsupportedFunctions,
            unsupportedCallbacks: vmMetrics.unsupportedCallbacks,
            fallbackFunctions: vmMetrics.fallbackFunctions,
            nonVmCompatibleFunctions: vmMetrics.nonVmCompatibleFunctions,
            yieldSensitiveFunctions: vmMetrics.yieldSensitiveFunctions,
            environmentSensitiveFunctions: vmMetrics.environmentSensitiveFunctions,
            dedicatedInterpreterRequiredFunctions: vmMetrics.dedicatedInterpreterRequiredFunctions,
            selectionDetails: vmMetrics.selectionDetails,
            fallbackCategoryCounts: vmMetrics.fallbackCategoryCounts,
            vmInstructionCount: vmMetrics.vmInstructionCount,
            eligibleAstNodes: vmMetrics.eligibleAstNodes,
            virtualizedAstNodes: vmMetrics.virtualizedAstNodes,
            functionCoveragePercent: vmMetrics.functionCoveragePercent,
            astCoveragePercent: vmMetrics.astCoveragePercent,
            nestedFunctionsDiscovered: vmMetrics.nestedFunctionsDiscovered,
            nestedFunctionsSelected: vmMetrics.nestedFunctionsSelected,
            nestedFunctionsVirtualized: vmMetrics.nestedFunctionsVirtualized,
            closuresCreated: vmMetrics.closuresCreated,
            capturedUpvalues: vmMetrics.capturedUpvalues,
            functionDeclarationSkips: vmMetrics.functionDeclarationSkips,
            interpreterTemplate: vmMetrics.interpreterTemplates.length
                ? [...new Set(vmMetrics.interpreterTemplates)].join(',')
                : null,
            instructionLayout: vmMetrics.instructionLayouts
            ,constantPoolStrategies: [...new Set(vmMetrics.constantPoolStrategies)]
            ,operandEncodings: [...new Set(vmMetrics.operandEncodings)]
            ,...hellMetadata
        },
        report: {
            profile: build.profile,
            vmMode: build.vmMode,
            vmRequested,
            vmApplied,
            vmReason,
            skipReasons,
            skippedByReason,
            fingerprint: build.fingerprint,
            protectedStringCount: transformed.report.protectedStringCount,
            decoderFamilyCount: transformed.report.decoderFamilyCount,
            decoderFamilies: transformed.report.decoderFamilies,
            uniqueAstFingerprintCount: transformed.report.uniqueAstFingerprintCount + (useLegacyPayloadWrapper ? 1 : 0),
            helperCount: transformed.report.helperCount + (useLegacyPayloadWrapper ? 1 : 0),
            vmFunctionCount: vmMetrics.virtualizedFunctions,
            interpreterInstanceCount: vmMetrics.interpreterInstanceCount,
            interpreterFamiliesUsed: vmMetrics.interpreterFamiliesUsed,
            sharedInterpreterCount: vmMetrics.sharedInterpreterCount,
            dedicatedInterpreterCount: vmMetrics.dedicatedInterpreterCount,
            fusedInstructionCount: vmMetrics.fusedInstructionCount,
            splitInstructionCount: vmMetrics.splitInstructionCount,
            shuffledBlockCount: vmMetrics.shuffledBlockCount,
            normalizedSimilarity: vmMetrics.normalizedSimilarity,
            nestedVmFunctionCount: vmMetrics.nestedVmFunctionCount,
            discoveredFunctions: vmMetrics.discoveredFunctions,
            discoveredFunctionCandidates: vmMetrics.discoveredFunctionCandidates,
            eligibleFunctions: vmMetrics.eligibleFunctions,
            selectedFunctions: vmMetrics.selectedFunctions,
            virtualizedFunctions: vmMetrics.virtualizedFunctions,
            skippedFunctions: vmMetrics.skippedFunctions,
            eligibleSkippedFunctions: vmMetrics.eligibleSkippedFunctions,
            excludedFunctions: vmMetrics.excludedFunctions,
            excludedCallbacks: vmMetrics.excludedCallbacks,
            budgetLimitedFunctions: vmMetrics.budgetLimitedFunctions,
            budgetLimitedCallbacks: vmMetrics.budgetLimitedCallbacks,
            unsupportedFunctions: vmMetrics.unsupportedFunctions,
            unsupportedCallbacks: vmMetrics.unsupportedCallbacks,
            fallbackFunctions: vmMetrics.fallbackFunctions,
            nonVmCompatibleFunctions: vmMetrics.nonVmCompatibleFunctions,
            yieldSensitiveFunctions: vmMetrics.yieldSensitiveFunctions,
            environmentSensitiveFunctions: vmMetrics.environmentSensitiveFunctions,
            dedicatedInterpreterRequiredFunctions: vmMetrics.dedicatedInterpreterRequiredFunctions,
            selectionDetails: vmMetrics.selectionDetails,
            fallbackCategoryCounts: vmMetrics.fallbackCategoryCounts,
            vmInstructionCount: vmMetrics.vmInstructionCount,
            eligibleAstNodes: vmMetrics.eligibleAstNodes,
            virtualizedAstNodes: vmMetrics.virtualizedAstNodes,
            functionCoveragePercent: vmMetrics.functionCoveragePercent,
            astCoveragePercent: vmMetrics.astCoveragePercent,
            nestedFunctionsDiscovered: vmMetrics.nestedFunctionsDiscovered,
            nestedFunctionsSelected: vmMetrics.nestedFunctionsSelected,
            nestedFunctionsVirtualized: vmMetrics.nestedFunctionsVirtualized,
            closuresCreated: vmMetrics.closuresCreated,
            capturedUpvalues: vmMetrics.capturedUpvalues,
            functionDeclarationSkips: vmMetrics.functionDeclarationSkips,
            vmFunctions: publicVmFunctions,
            opcodeMap: vmMetrics.opcodeMap,
            branchOrders: vmMetrics.branchOrders,
            interpreterTemplate: vmMetrics.interpreterTemplates.length
                ? [...new Set(vmMetrics.interpreterTemplates)].join(',')
                : null,
            instructionLayout: vmMetrics.instructionLayouts,
            constantPoolStrategies: [...new Set(vmMetrics.constantPoolStrategies)],
            operandEncodings: [...new Set(vmMetrics.operandEncodings)],
            ...hellMetadata,
            originalBytes,
            outputBytes,
            expansionRatio,
            processingTimeMs,
            vmOutputStructure: vmStructure,
            pipelineDiagnostics: {
                publicProfileReceived: normalized.publicProfile,
                mappedVmMode: build.vmMode,
                discoveredFunctions: vmMetrics.discoveredFunctions,
                eligibleFunctions: vmMetrics.eligibleFunctions,
                selectedFunctions: vmMetrics.selectedFunctions,
                compiledFunctions: vmMetrics.virtualizedFunctions,
                skipReasons,
                vmCodePassedToEmitter: vmApplied,
                postVmTransformApplied: applyPostVmTransforms,
                vmStructurePreserved: vmStructure ? vmStructure.valid : false
            },
            legacyPayloadWrapper: useLegacyPayloadWrapper,
            vmAstObfuscationSkipped: !applyPostVmTransforms,
            dependencyGraphSize: transformed.report.dependencyGraphSize + (useLegacyPayloadWrapper ? 1 : 0),
            directDecoderCallRatio: transformed.report.directDecoderCallRatio,
            dynamicKeyRatio: transformed.report.dynamicKeyRatio,
            alphabetReuseRatio: transformed.report.alphabetReuseRatio,
            adversarial: analyzeObfuscatedCode(code),
            estimatedAnalysisCost: transformed.report.estimatedAnalysisCost + (useLegacyPayloadWrapper ? 25 : 0)
        }
    };
};

const obfuscate = async (source, options = {}) => {
    const result = await obfuscateDetailed(source, options);
    return result.code;
};

app.post('/obfuscate', async (req, res) => {
    const started = Date.now();
    const telemetryProfile = typeof req.body?.profile === 'string' ? req.body.profile : 'unknown';
    let observedSourceBytes = 0;
    const rejectRequest = error => {
        const response = publicErrorFor(error);
        telemetry.record({
            profile: telemetryProfile,
            sourceBytes: observedSourceBytes,
            durationMs: Date.now() - started,
            code: response.payload.code
        });
        return res.status(response.status).json(response.payload);
    };
    const code = req.body && req.body.code;
    if (!code || !String(code).trim()) {
        return rejectRequest({ code: 'SOURCE_REQUIRED' });
    }
    const source = String(code);
    const inputBytes = Buffer.byteLength(source, 'utf8');
    observedSourceBytes = inputBytes;
    if (inputBytes > SERVICE_LIMITS.maxSourceBytes) {
        return rejectRequest({ code: 'SOURCE_TOO_LARGE' });
    }
    const requestedPublicProfile = req.body.profile || 'light_plus';
    if (!Object.hasOwn(PUBLIC_PROFILES, requestedPublicProfile)) {
        return rejectRequest({ code: 'PROFILE_INVALID' });
    }
    if (!isPublicProfileAvailable(requestedPublicProfile)) {
        return rejectRequest({ code: 'PROFILE_UNAVAILABLE' });
    }

    const accountId = String(req.get('x-account-id') || 'anonymous').slice(0, 128);
    const ipRate = ipLimiter.consume(req.ip || req.socket.remoteAddress || 'unknown');
    const accountRate = accountLimiter.consume(accountId);
    if (!ipRate.allowed || !accountRate.allowed) {
        const retryAfterMs = Math.max(ipRate.retryAfterMs, accountRate.retryAfterMs);
        res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        return rejectRequest({ code: 'RATE_LIMITED' });
    }

    const idempotencyKey = String(req.get('x-idempotency-key') || crypto.randomUUID()).slice(0, 256);
    let transaction;
    try {
        transaction = creditLedger.begin(accountId, idempotencyKey);
    } catch (error) {
        return rejectRequest(error);
    }
    if (transaction.duplicate && !transaction.committed) {
        return rejectRequest({ code: 'IDEMPOTENCY_IN_PROGRESS' });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', () => { if (!res.writableEnded) abort(); });
    try {
        const result = await getBuildPool().submit(source, {
            deadCodeProbability: req.body.deadCodeProbability,
            useVm: req.body.useVm === true || req.body.vm === true || req.body.mode === 'vm',
            vmMode: req.body.vmMode,
            vmStrict: req.body.vmStrict === true || req.body.vm_strict === true,
            seed: req.body.seed,
            digitFree: req.body.digitFree === true || req.body.mode === 'digit-free',
            profile: requestedPublicProfile,
            version: req.body.version,
            devMode: req.body.devMode === true
        }, { signal: controller.signal });

        const outputBytes = Buffer.byteLength(result.code, 'utf8');
        const billing = await creditLedger.commit(transaction, {
            buildId: result.build.buildId,
            profile: requestedPublicProfile,
            inputBytes,
            outputBytes,
            durationMs: Date.now() - started,
            runtimeVersion: null
        });
        telemetry.record({
            buildId: result.build.buildId,
            profile: requestedPublicProfile,
            sourceBytes: inputBytes,
            outputBytes,
            durationMs: Date.now() - started,
            code: 'SUCCESS',
            fallbackCount: result.build.fallbackFunctions,
            runtimeVersion: result.build.runtimeVersion || null
        });

        res.json({
            status: 'success',
            original_length: source.length,
            obfuscated: result.code,
            build: result.build,
            report: result.report,
            billing: { charged: billing.charged, idempotentReplay: billing.duplicate }
        });
    } catch (err) {
        creditLedger.abort(transaction);
        if (controller.signal.aborted && err.code !== 'REQUEST_ABORTED') err.code = 'REQUEST_ABORTED';
        const response = publicErrorFor(err);
        telemetry.record({
            profile: requestedPublicProfile,
            sourceBytes: inputBytes,
            durationMs: Date.now() - started,
            code: response.payload.code
        });
        if (err.code === 'GOOD_VM_NOT_APPLIED' && err.build) {
            response.payload = {
                ...response.payload,
                error: err.message,
                vmRequested: true,
                vmApplied: false,
                build: err.build
            };
        }
        if (!res.headersSent) res.status(response.status).json(response.payload);
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: PRODUCT_VERSION,
        profiles: {
            light: { status: 'available' },
            light_plus: { status: 'available' },
            good: { status: 'available', recommended: true },
            pro: {
                status: 'experimental',
                warning: 'Experimental profile. Test generated output before release.'
            },
            hell: { status: 'unavailable', available: false },
            blatant: { status: 'unavailable', available: false },
            fatality: { status: 'unavailable', available: false }
        },
        retention: 'disabled'
    });
});

app.get('/ready', (req, res) => {
    const workers = getBuildPool().status();
    const ready = workers.accepting && workers.queued < workers.maxQueueDepth;
    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'busy',
        version: PRODUCT_VERSION,
        workers
    });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const code = error?.type === 'entity.too.large'
        ? 'SOURCE_TOO_LARGE'
        : error?.type === 'entity.parse.failed' ? 'INVALID_JSON' : 'BUILD_FAILED';
    const response = publicErrorFor({ code });
    telemetry.record({ profile: 'unknown', sourceBytes: 0, durationMs: 0, code: response.payload.code });
    res.status(response.status).json(response.payload);
});

if (require.main === module) {
    const server = app.listen(PORT, () => console.log(`SukaRed API listening on ${PORT}`));
    const shutdown = async () => {
        server.close();
        if (buildPool) await buildPool.drain();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

module.exports = {
    app,
    obfuscate,
    obfuscateDetailed,
    getErrorContext,
    getBuildPool,
    creditLedger,
    ipLimiter,
    accountLimiter,
    publicErrorFor,
    SERVICE_LIMITS,
    telemetry
};
