const express = require('express');
const cors = require('cors');

const { preprocess } = require('./core/preprocessor');
const { injectDeadCode } = require('./core/dead_code_enjector');
const { transformAst } = require('./core/ast_traverser');
const { attachDecoderRuntime } = require('./utils/braille_cipher');
const { minifyLuau } = require('./core/luau_minifier');
const { KNOWN_GLOBALS, LUA_KEYWORDS } = require('./utils/luau_terms');
const { createBuildConfig, PROFILES } = require('./core/build_config');
const { analyzeObfuscatedCode } = require('./core/adversarial_analyzer');
const { virtualizeSource } = require('./core/vm/virtualizer');
const { emptyVmMetrics } = require('./core/vm/metrics');

const app = express();
const PORT = process.env.PORT || 3000;
const PRODUCT_VERSION = 'SukaRed 1.0';
const VALID_PROFILES = new Set(['light', 'balanced', 'strong']);
const VALID_VM_MODES = new Set(['off', 'selected', 'aggressive']);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const normalizeVmMode = (profile, requested) => {
    const value = requested || (profile === 'strong' ? 'selected' : 'off');
    if (!VALID_VM_MODES.has(value)) throw new Error('Invalid VM mode.');
    if (profile === 'light' && value !== 'off') throw new Error('Light profile supports VM Off only.');
    if (profile === 'balanced' && value === 'aggressive') throw new Error('Balanced profile supports VM Off or Selected only.');
    return value;
};

const normalizeOptions = (options = {}) => {
    const profile = options.profile || 'balanced';
    if (!VALID_PROFILES.has(profile)) throw new Error('Invalid profile.');
    const legacyVmMode = options.useVm === true || options.vm === true ? 'selected' : undefined;
    return {
        ...options,
        profile,
        vmMode: normalizeVmMode(profile, options.vmMode || legacyVmMode)
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
        seed: normalized.seed || build.randomId
    });
    const vmMetrics = vmResult.metrics || emptyVmMetrics(build.vmMode);
    const withDeadCode = await injectDeadCode(vmResult.code, {
        probability: build.deadCodeProbability,
        digitFree: build.digitFree,
        fingerprint: build.fingerprint
    });
    const vmOutputOwnsRuntime = vmMetrics.virtualizedFunctions > 0;
    const transformed = vmOutputOwnsRuntime
        ? {
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
        }
        : await transformAst(withDeadCode, {
            digitFree: build.digitFree,
            hideNumbers: build.hideNumbers,
            decoderFamilies: build.decoderFamilies,
            inlineStringRate: build.inlineStringRate,
            flattenRate: build.flattenRate
        });
    const obfuscated = attachDecoderRuntime(transformed.code, transformed.hasEncryptedStrings);
    const useLegacyPayloadWrapper = false;
    const code = obfuscated;
    const processingTimeMs = Date.now() - started;
    const originalBytes = Buffer.byteLength(String(source || ''), 'utf8');
    const outputBytes = Buffer.byteLength(code, 'utf8');
    const expansionRatio = originalBytes ? Number((outputBytes / originalBytes).toFixed(2)) : 0;
    return {
        code,
        build: {
            version: PRODUCT_VERSION,
            profile: build.profile,
            vmMode: build.vmMode,
            buildId: build.fingerprint,
            originalBytes,
            outputBytes,
            expansionRatio,
            processingTimeMs,
            virtualizedFunctions: vmMetrics.virtualizedFunctions,
            vmApplied: vmMetrics.virtualizedFunctions > 0,
            protectedStrings: transformed.report.protectedStringCount,
            selectedFunctions: vmMetrics.selectedFunctions,
            skippedFunctions: vmMetrics.skippedFunctions,
            vmInstructionCount: vmMetrics.vmInstructionCount
        },
        report: {
            profile: build.profile,
            vmMode: build.vmMode,
            fingerprint: build.fingerprint,
            protectedStringCount: transformed.report.protectedStringCount,
            decoderFamilyCount: transformed.report.decoderFamilyCount,
            decoderFamilies: transformed.report.decoderFamilies,
            uniqueAstFingerprintCount: transformed.report.uniqueAstFingerprintCount + (useLegacyPayloadWrapper ? 1 : 0),
            helperCount: transformed.report.helperCount + (useLegacyPayloadWrapper ? 1 : 0),
            vmFunctionCount: vmMetrics.virtualizedFunctions,
            selectedFunctions: vmMetrics.selectedFunctions,
            virtualizedFunctions: vmMetrics.virtualizedFunctions,
            skippedFunctions: vmMetrics.skippedFunctions,
            vmInstructionCount: vmMetrics.vmInstructionCount,
            vmFunctions: vmMetrics.functions,
            opcodeMap: vmMetrics.opcodeMap,
            branchOrders: vmMetrics.branchOrders,
            legacyPayloadWrapper: useLegacyPayloadWrapper,
            vmAstObfuscationSkipped: vmOutputOwnsRuntime,
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
    const code = req.body && req.body.code;
    if (!code || !String(code).trim()) return res.status(400).json({ error: 'Code is required.' });
    const legacyModeProfile = VALID_PROFILES.has(req.body.mode) ? req.body.mode : undefined;

    try {
        const result = await obfuscateDetailed(String(code), {
            deadCodeProbability: req.body.deadCodeProbability,
            useVm: req.body.useVm === true || req.body.vm === true || req.body.mode === 'vm',
            vmMode: req.body.vmMode,
            vmStrict: req.body.vmStrict === true || req.body.vm_strict === true,
            seed: req.body.seed,
            digitFree: req.body.digitFree === true || req.body.mode === 'digit-free',
            profile: req.body.profile || legacyModeProfile,
            version: req.body.version,
            devMode: req.body.devMode === true
        });

        res.json({
            status: 'success',
            original_length: code.length,
            obfuscated: result.code,
            build: result.build,
            report: result.report
        });
    } catch (err) {
        if (/Invalid|supports VM|Code is required/.test(err.message || '')) {
            return res.status(400).json({ error: err.message });
        }
        const preprocessed = await preprocess(String(code)).catch(() => '');
        const context = err.sourceContext || getErrorContext(preprocessed, err);
        const stage = err.stage ? ` [${err.stage}]` : '';
        res.status(500).json({
            error: `Obfuscation failed${stage}: ${err.message}${context ? ` | context: ${context}` : ''}`
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        modules: ['preprocessor', 'dead_code_enjector', 'ast_traverser', 'braille_cipher', 'alphabet_registry', 'vmEngine'],
        version: PRODUCT_VERSION,
        profiles: Object.keys(PROFILES),
        luau_terms: {
            keywords: LUA_KEYWORDS.size,
            globals: KNOWN_GLOBALS.size
        }
    });
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`SukaRed API listening on ${PORT}`));
}

module.exports = {
    app,
    obfuscate,
    obfuscateDetailed,
    getErrorContext
};
