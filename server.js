const express = require('express');
const cors = require('cors');

const { preprocess } = require('./core/preprocessor');
const { injectDeadCode } = require('./core/dead_code_enjector');
const { transformAst } = require('./core/ast_traverser');
const { attachDecoderRuntime } = require('./utils/braille_cipher');
const { createVmBundle } = require('./vmEngine');
const { KNOWN_GLOBALS, LUA_KEYWORDS } = require('./utils/luau_terms');
const { createBuildConfig, PROFILES } = require('./core/build_config');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

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

const obfuscate = async (source, options = {}) => {
    const build = createBuildConfig(options);
    const preprocessed = await preprocess(source);
    const withDeadCode = await injectDeadCode(preprocessed, {
        probability: build.deadCodeProbability,
        digitFree: build.digitFree,
        fingerprint: build.fingerprint
    });
    const transformed = await transformAst(withDeadCode, {
        digitFree: build.digitFree,
        hideNumbers: build.hideNumbers,
        decoderFamilies: build.decoderFamilies,
        inlineStringRate: build.inlineStringRate,
        flattenRate: build.flattenRate
    });
    const obfuscated = attachDecoderRuntime(transformed.code, transformed.hasEncryptedStrings);
    return build.useVm ? createVmBundle(obfuscated, {
        digitFree: build.digitFree,
        integrity: build.integrity,
        devMode: options.devMode === true
    }) : obfuscated;
};

app.post('/obfuscate', async (req, res) => {
    const code = req.body && req.body.code;
    if (!code) return res.status(400).json({ error: 'Code is required.' });

    try {
        const obfuscated = await obfuscate(String(code), {
            deadCodeProbability: req.body.deadCodeProbability,
            useVm: req.body.useVm === true || req.body.vm === true || req.body.mode === 'vm',
            digitFree: req.body.digitFree === true || req.body.mode === 'digit-free',
            profile: req.body.profile || req.body.mode,
            version: req.body.version,
            devMode: req.body.devMode === true
        });

        res.json({
            status: 'success',
            original_length: code.length,
            obfuscated
        });
    } catch (err) {
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
    getErrorContext
};
