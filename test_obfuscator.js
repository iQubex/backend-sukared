const assert = require('assert');
const luaparse = require('luaparse');
const { obfuscate } = require('./server');
const { preprocess } = require('./core/preprocessor');
const { transformAst } = require('./core/ast_traverser');

const sample = 'print("Hello SukaRed")';

const JAPANESE_ALPHABET = ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ', 'タ'];

const parseLuau = (code) => luaparse.parse(code, { comments: false, luaVersion: '5.2' });

let runtimePromise;

const getRuntime = async () => {
    if (!runtimePromise) {
        runtimePromise = (async () => {
            delete WebAssembly.Suspending;
            delete WebAssembly.promising;
            return import('./node_modules/luau-web/src/index.js');
        })();
    }
    return runtimePromise;
};

const runLuau = async (source, options = {}) => {
    const { LuauState } = await getRuntime();
    const out = [];
    const state = await LuauState.createAsync({
        print: (...args) => out.push(args.map(String).join(' '))
    });
    state.env.set('loadstring', (src) => state.loadstring(String(src), 'inner', true), true);

    try {
        const fn = state.loadstring(source, options.chunk || 'test', true);
        if (typeof fn !== 'function') throw new Error(`Luau loadstring did not return a function: ${String(fn).slice(0, 240)}`);
        await fn();
        return out.join('\n');
    } finally {
        if (options.destroy === true) state.destroy();
    }
};

const run = async () => {
    const expected = await runLuau(sample, { chunk: 'original' });
    assert.strictEqual(expected, 'Hello SukaRed');

    for (const profile of ['light', 'balanced', 'strong']) {
        const code = await obfuscate(sample, { profile, devMode: true });
        assert(!/Hello SukaRed/.test(code), `${profile}: source string leaked`);
        assert(!/[\r\n]/.test(code), `${profile}: output is not single-line`);
        parseLuau(code);
        assert.strictEqual(await runLuau(code, { chunk: profile }), expected, `${profile}: runtime output mismatch`);
    }

    const digitFree = await obfuscate(sample, { profile: 'strong', digitFree: true, useVm: true, devMode: true });
    assert(!/[0-9]/.test(digitFree), 'digit-free profile emitted a digit');
    assert(!/[\r\n]/.test(digitFree), 'digit-free output is not single-line');
    assert(!/#"[\u2800-\u28FF]+"/.test(digitFree), 'digit-free number encoding used Braille/Unicode length');
    parseLuau(digitFree);
    assert.strictEqual(await runLuau(digitFree, { chunk: 'digit-free' }), expected, 'digit-free runtime output mismatch');

    const reverseUnicode = await transformAst(await preprocess(sample), {
        decoderFamilies: ['reverseShift'],
        inlineStringRate: 0,
        forceAlphabet: JAPANESE_ALPHABET
    });
    parseLuau(reverseUnicode.code);
    assert.strictEqual(await runLuau(reverseUnicode.code, { chunk: 'reverse-unicode' }), expected, 'Japanese reverse decoder failed');

    const a = await obfuscate(sample, { profile: 'balanced' });
    const b = await obfuscate(sample, { profile: 'balanced' });
    assert.notStrictEqual(a, b, 'two builds should not be identical');

    console.log('SukaRed tests passed');
};

run().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
