const express = require('express');
const cors = require('cors');

const { preprocess } = require('./core/preprocessor');
const { injectDeadCode } = require('./core/dead_code_enjector');
const { transformAst } = require('./core/ast_traverser');
const { attachDecoderRuntime } = require('./utils/braille_cipher');
const { createVmBundle } = require('./vmEngine');
const { KNOWN_GLOBALS, LUA_KEYWORDS } = require('./utils/luau_terms');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const getErrorContext = (code, err) => {
    const match = String(err && err.message || '').match(/\[(\d+):(\d+)\]/);
    if (!match) return '';
    const lineNo = Number(match[1]);
    const lines = String(code || '').split('\n');
    const start = Math.max(1, lineNo - 2);
    const end = Math.min(lines.length, lineNo + 2);
    const excerpt = [];
    for (let line = start; line <= end; line++) {
        excerpt.push(`${line}: ${lines[line - 1] || ''}`);
    }
    return excerpt.join(' | ');
};

const obfuscate = async (source, options = {}) => {
    const preprocessed = await preprocess(source);
    const withDeadCode = await injectDeadCode(preprocessed, {
        probability: options.deadCodeProbability
    });
    const transformed = await transformAst(withDeadCode);
    const obfuscated = attachDecoderRuntime(transformed.code, transformed.hasEncryptedStrings);
    return options.useVm ? createVmBundle(obfuscated) : obfuscated;
};

app.post('/obfuscate', async (req, res) => {
    const code = req.body && req.body.code;
    if (!code) return res.status(400).json({ error: 'Kod gönder kanka!' });

    try {
        const obfuscated = await obfuscate(String(code), {
            deadCodeProbability: req.body.deadCodeProbability,
            useVm: req.body.useVm === true || req.body.vm === true || req.body.mode === 'vm'
        });

        res.json({
            status: 'success',
            original_length: code.length,
            obfuscated
        });
    } catch (err) {
        const preprocessed = await preprocess(String(code)).catch(() => '');
        const context = getErrorContext(preprocessed, err);
        res.status(500).json({
            error: `Obfuscation sırasında bir hata oluştu: ${err.message}${context ? ` | preprocessed: ${context}` : ''}`
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        modules: ['preprocessor', 'dead_code_enjector', 'ast_traverser', 'braille_cipher', 'alphabet_registry', 'vmEngine'],
        luau_terms: {
            keywords: LUA_KEYWORDS.size,
            globals: KNOWN_GLOBALS.size
        }
    });
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`SukaRed API ${PORT} portunda ayakta!`));
}

module.exports = {
    app,
    obfuscate
};
