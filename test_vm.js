const assert = require('assert');
const { obfuscateDetailed } = require('./server');
const { preprocess } = require('./core/preprocessor');
const { virtualizeSource } = require('./core/vm/virtualizer');

const vmPhase1Source = `
local function calc(a, b)
    local c = a + b
    local d = c * 2
    local e = d / 2
    return tonumber(e - 1)
end

print(calc(6, 2))
`;

const fallbackSource = `
local function supported(a, b)
    return a + b
end

local function unsupported(a)
    if a > 1 then
        return a
    end
    return 0
end

print(supported(2, 5))
`;

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

const runLuau = async (source, chunk = 'vm-test') => {
    const { LuauState } = await getRuntime();
    const out = [];
    const state = await LuauState.createAsync({
        print: (...args) => out.push(args.map(String).join(' '))
    });
    state.env.set('loadstring', (src) => state.loadstring(String(src), 'inner', true), true);
    const fn = state.loadstring(source, chunk, true);
    assert.strictEqual(typeof fn, 'function', 'Luau did not compile generated VM output');
    await fn();
    return out.join('\n');
};

const run = async () => {
    const original = await runLuau(vmPhase1Source, 'vm-original');
    assert.strictEqual(original, '7');

    const selectedA = await obfuscateDetailed(vmPhase1Source, {
        profile: 'strong',
        vmMode: 'selected',
        seed: 'seed-a',
        deadCodeProbability: 0,
        devMode: true
    });
    const selectedB = await obfuscateDetailed(vmPhase1Source, {
        profile: 'strong',
        vmMode: 'selected',
        seed: 'seed-b',
        deadCodeProbability: 0,
        devMode: true
    });
    const selectedC = await obfuscateDetailed(vmPhase1Source, {
        profile: 'strong',
        vmMode: 'selected',
        seed: 'layout-2',
        deadCodeProbability: 0,
        devMode: true
    });

    assert.notStrictEqual(selectedA.code, selectedB.code, 'two VM seeds should produce different output');
    assert.notStrictEqual(selectedB.code, selectedC.code, 'three VM seeds should produce different output');
    assert.notDeepStrictEqual(selectedA.report.opcodeMap, selectedB.report.opcodeMap, 'two VM seeds should produce different opcode maps');
    assert.notDeepStrictEqual(selectedB.report.opcodeMap, selectedC.report.opcodeMap, 'three VM seeds should produce different opcode maps');
    assert.notDeepStrictEqual(selectedA.report.branchOrders, selectedB.report.branchOrders, 'two VM seeds should produce different interpreter branch order');
    const layoutSignatures = [selectedA, selectedB, selectedC].map(result => JSON.stringify(result.report.instructionLayout));
    assert.strictEqual(new Set(layoutSignatures).size, 3, 'three VM seeds should produce distinct instruction layout signatures');
    assert.strictEqual(selectedA.build.virtualizedFunctions, 1, 'selected mode should virtualize one supported function');
    assert.strictEqual(selectedA.build.vmApplied, true, 'build metadata should report VM applied only when functions are virtualized');
    assert.strictEqual(selectedA.build.selectedFunctions, 1, 'build metadata should include selectedFunctions');
    assert(selectedA.build.vmInstructionCount >= 9, 'VM Phase 1 should emit real instructions');
    assert.strictEqual(selectedA.build.interpreterTemplate, 'conditional-register-v1', 'build metadata should report interpreter template');
    assert(Array.isArray(selectedA.build.instructionLayout), 'build metadata should report instruction layout');
    assert(!Object.hasOwn(selectedA.report.vmFunctions[0], 'constants'), 'public VM report must not expose decoded constants');
    assert(!Object.hasOwn(selectedA.report.vmFunctions[0], 'bytecode'), 'public VM report must not expose bytecode payloads');
    assert(!/loadstring\s*\(/i.test(selectedA.code), 'VM output must not wrap the whole script with loadstring');
    assert(!/local\s+function\s+calc\s*\(/.test(selectedA.code), 'selected function declaration remained visible');
    assert(!/local\s+c\s*=\s*a\s*\+\s*b/.test(selectedA.code), 'selected function body local add remained visible');
    assert(!/local\s+d\s*=\s*c\s*\*\s*2/.test(selectedA.code), 'selected function body multiplication remained visible');
    assert(!/return\s+tonumber\s*\(\s*e\s*-\s*1\s*\)/.test(selectedA.code), 'selected function return body remained visible');
    assert(/while true do/.test(selectedA.code), 'generated VM output should include an interpreter loop');
    assert.strictEqual(await runLuau(selectedA.code, 'vm-selected-a'), original);
    assert.strictEqual(await runLuau(selectedB.code, 'vm-selected-b'), original);
    assert.strictEqual(await runLuau(selectedC.code, 'vm-selected-c'), original);

    const preprocessed = await preprocess(vmPhase1Source);
    const rawVm = await virtualizeSource(preprocessed, { vmMode: 'selected', seed: 'seed-a' });
    assert(!/local\s+c\s*=\s*a\s*\+\s*b/.test(rawVm.code), 'original function body remained visible after VM transform');
    assert(/while true do/.test(rawVm.code), 'interpreter loop was not generated');
    assert(/\{[0-9,\s]+\}/.test(rawVm.code), 'bytecode array was not generated');
    assert(rawVm.metrics.functions[0].ir.some(inst => inst.op === 'LOAD_CONST'), 'IR should include LOAD_CONST');
    assert(rawVm.metrics.functions[0].ir.some(inst => inst.op === 'ADD'), 'IR should include ADD');
    assert(rawVm.metrics.functions[0].ir.some(inst => inst.op === 'CALL'), 'IR should include CALL');
    assert(rawVm.metrics.functions[0].bytecode.length > 0, 'encoded bytecode should be recorded');

    const runtimeLayouts = new Map();
    for (let i = 0; i < 100 && runtimeLayouts.size < 3; i++) {
        const candidate = await virtualizeSource(preprocessed, {
            vmMode: 'selected',
            seed: `layout-runtime-${i}`
        });
        const layout = candidate.metrics.instructionLayouts[0].layout;
        if (!runtimeLayouts.has(layout)) runtimeLayouts.set(layout, candidate.code);
    }
    assert.deepStrictEqual(
        [...runtimeLayouts.keys()].sort(),
        ['flat', 'segmented', 'table'],
        'all instruction storage layouts should be generated'
    );
    for (const [layout, code] of runtimeLayouts) {
        assert.strictEqual(await runLuau(code, `vm-layout-${layout}`), original, `${layout} layout changed behavior`);
    }

    const aggressive = await obfuscateDetailed(fallbackSource, {
        profile: 'strong',
        vmMode: 'aggressive',
        seed: 'seed-c',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(await runLuau(aggressive.code, 'vm-aggressive'), '7');
    assert.strictEqual(aggressive.build.virtualizedFunctions, 1, 'aggressive mode should virtualize supported function');
    assert(aggressive.build.skippedFunctions >= 1, 'aggressive mode should report skipped unsupported functions');

    const noVm = await obfuscateDetailed(fallbackSource, {
        profile: 'balanced',
        vmMode: 'off',
        seed: 'seed-no-vm',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(noVm.build.virtualizedFunctions, 0, 'vm off should not virtualize functions');
    assert.strictEqual(noVm.build.vmApplied, false, 'frontend metadata must not claim VM was applied when no functions were virtualized');

    let strictFailed = false;
    try {
        await obfuscateDetailed(fallbackSource, {
            profile: 'strong',
            vmMode: 'selected',
            vmStrict: true,
            seed: 'seed-strict',
            deadCodeProbability: 0,
            devMode: true
        });
    } catch (err) {
        strictFailed = /SukaRed VM error|unsupported/.test(err.message);
    }
    assert(strictFailed, 'vm-strict should fail when a selected function is unsupported');

    console.log('SukaRed VM tests passed');
};

run().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
