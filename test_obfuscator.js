const assert = require('assert');
const fs = require('fs');
const luaparse = require('luaparse');
const { obfuscate, obfuscateDetailed } = require('./server');
const { preprocess } = require('./core/preprocessor');
const { transformAst } = require('./core/ast_traverser');
const { analyzeObfuscatedCode } = require('./core/adversarial_analyzer');

const sample = 'print("Hello SukaRed")';

const functionExpressionRegression = `
local t = {3, 1, 2}
table.sort(t, function(a, b)
    return a < b
end)
print(table.concat(t, ","))

local callback = function(fn)
    return fn()
end

local x = callback(function()
    return 1
end)
print(x)

local function foo(a, fn, b)
    print(fn(a) + b)
end

foo(1, function(a)
    return a * 2
end, 3)

local value =
    "a"
    .. "b"
print(value)
`;

const methodSelfRegression = `
local T = {}

function T:Inc()
    self.v = self.v + 1
end

local t = { v = 1 }
setmetatable(t, { __index = T })

t:Inc()

assert(t.v == 2)
print(t.v)
`;

const shorthandMethodRegression = `
local T = {}

function T:Echo(value)
    return value
end

function T:Read(value)
    return value.answer
end

print(T:Echo'Head')
print(T:Read{ answer = 42 })
print(T:Echo[[long value]])
print(("value %d"):format(7))
`;

const adversarialSample = `
print("alpha")
print("beta")
print("gamma")
print("delta")
print("epsilon")
print("zeta")
print("eta")
print("theta")
print("iota")
print("kappa")
print("lambda")
print("mu")
`;

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

    const regressionExpected = await runLuau(functionExpressionRegression, { chunk: 'function-expression-original' });
    assert.strictEqual(regressionExpected, '1,2,3\n1\n5\nab');
    for (const profile of ['light', 'balanced', 'strong']) {
        const code = await obfuscate(functionExpressionRegression, { profile, devMode: true });
        parseLuau(code);
        assert.strictEqual(
            await runLuau(code, { chunk: `function-expression-${profile}` }),
            regressionExpected,
            `${profile}: function expression regression failed`
        );
    }

    const digitFree = await obfuscate(sample, { profile: 'strong', digitFree: true, useVm: true, devMode: true });
    assert(!/[0-9]/.test(digitFree), 'digit-free profile emitted a digit');
    assert(!/[\r\n]/.test(digitFree), 'digit-free output is not single-line');
    assert(!/#"[\u2800-\u28FF]+"/.test(digitFree), 'digit-free number encoding used Braille/Unicode length');
    parseLuau(digitFree);
    assert.strictEqual(await runLuau(digitFree, { chunk: 'digit-free' }), expected, 'digit-free runtime output mismatch');

    const methodExpected = await runLuau(methodSelfRegression, { chunk: 'method-original' });
    assert.strictEqual(methodExpected, '2');
    for (const options of [
        { profile: 'light', devMode: true },
        { profile: 'balanced', devMode: true },
        { profile: 'strong', devMode: true },
        { profile: 'strong', useVm: true, devMode: true },
        { profile: 'strong', useVm: true, digitFree: true, devMode: true }
    ]) {
        const code = await obfuscate(methodSelfRegression, options);
        parseLuau(code);
        assert.strictEqual(
            await runLuau(code, { chunk: `method-${JSON.stringify(options)}` }),
            methodExpected,
            `method self regression failed for ${JSON.stringify(options)}`
        );
    }

    const shorthandExpected = await runLuau(shorthandMethodRegression, { chunk: 'shorthand-method-original' });
    assert.strictEqual(shorthandExpected, 'Head\n42\nlong value\nvalue 7');
    const shorthandPreprocessed = await preprocess(shorthandMethodRegression);
    assert(shorthandPreprocessed.includes(":Echo'Head'"), 'preprocessor removed a quoted shorthand method call');
    assert(shorthandPreprocessed.includes(':Read{ answer = 42 }'), 'preprocessor removed a table shorthand method call');
    assert(shorthandPreprocessed.includes(':Echo[[long value]]'), 'preprocessor removed a long-string shorthand method call');
    for (const profile of ['light', 'balanced', 'strong']) {
        const code = await obfuscate(shorthandMethodRegression, { profile, devMode: true });
        parseLuau(code);
        assert.strictEqual(
            await runLuau(code, { chunk: `shorthand-method-${profile}` }),
            shorthandExpected,
            `${profile}: shorthand method regression failed`
        );
    }

    const reverseUnicode = await transformAst(await preprocess(sample), {
        decoderFamilies: ['reverseShift'],
        inlineStringRate: 0,
        forceAlphabet: JAPANESE_ALPHABET
    });
    parseLuau(reverseUnicode.code);
    assert.strictEqual(await runLuau(reverseUnicode.code, { chunk: 'reverse-unicode' }), expected, 'Japanese reverse decoder failed');

    for (const family of ['shift', 'reverseShift', 'xor', 'stateful', 'bytes', 'closure', 'tableDriven', 'runtimeGenerated']) {
        const transformed = await transformAst(await preprocess(sample), {
            decoderFamilies: [family],
            inlineStringRate: family === 'bytes' ? 1 : 0
        });
        parseLuau(transformed.code);
        assert.strictEqual(
            await runLuau(transformed.code, { chunk: `decoder-family-${family}` }),
            expected,
            `${family} decoder family failed`
        );
    }

    const detailed = await obfuscateDetailed(sample, { profile: 'strong', devMode: true });
    assert(detailed.report.protectedStringCount > 0, 'build report did not count protected strings');
    assert(detailed.report.decoderFamilyCount > 0, 'build report did not count decoder families');
    assert(detailed.report.estimatedAnalysisCost > 0, 'build report did not include analysis cost');

    const adversarialExpected = await runLuau(adversarialSample, { chunk: 'adversarial-original' });
    const adversarialTransformed = await transformAst(await preprocess(adversarialSample), {
        decoderFamilies: ['shift', 'reverseShift', 'xor', 'stateful', 'bytes', 'closure', 'tableDriven', 'runtimeGenerated'],
        inlineStringRate: 0.35,
        hideNumbers: true,
        flattenRate: 0.75
    });
    parseLuau(adversarialTransformed.code);
    assert.strictEqual(await runLuau(adversarialTransformed.code, { chunk: 'adversarial-obfuscated' }), adversarialExpected);
    const adversarial = analyzeObfuscatedCode(adversarialTransformed.code);
    assert(adversarial.staticRecoveredStringRatio < 0.25, `static recovery ratio too high: ${JSON.stringify(adversarial)}`);
    assert(adversarialTransformed.report.alphabetReuseRatio < 0.25, `alphabet reuse ratio too high: ${JSON.stringify(adversarialTransformed.report)}`);
    assert(adversarialTransformed.report.directDecoderCallRatio < 0.2, `direct decoder ratio too high: ${JSON.stringify(adversarialTransformed.report)}`);

    const a = await obfuscate(sample, { profile: 'balanced' });
    const b = await obfuscate(sample, { profile: 'balanced' });
    assert.notStrictEqual(a, b, 'two builds should not be identical');

    const parserSuitePath = 'C:/Users/missk/Downloads/sukared_luau_runtime_tests_parser_compatible.lua';
    if (fs.existsSync(parserSuitePath)) {
        const parserSuite = fs.readFileSync(parserSuitePath, 'utf8');
        const code = await obfuscate(parserSuite, { profile: 'balanced', deadCodeProbability: 1, devMode: true });
        parseLuau(code);
    }

    console.log('SukaRed tests passed');
};

run().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
