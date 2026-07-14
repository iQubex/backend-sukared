const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { generateStressCorpus } = require('./tests/generate_vm_stress_corpus');
const { buildSource, runLuau, saveFailure, DEFAULT_LIMITS } = require('./tests/stress_harness');

const PROFILES = ['Light', 'Light+', 'Good', 'Pro'];
const LIMITS = {
    ...DEFAULT_LIMITS,
    buildTimeoutMs: 30000,
    runtimeTimeoutMs: 30000,
    maxOutputBytes: 8 * 1024 * 1024,
    maxHeapGrowth: 512 * 1024 * 1024,
    maxVmInstructions: 6000,
    maxInterpreterInstances: 64
};
const fixturePath = name => path.join(__dirname, 'tests', 'regressions', name);
const readFixture = name => fs.readFileSync(fixturePath(name), 'utf8');

const fixtures = [
    {
        name: 'small-arithmetic',
        source: 'local function calculate(a,b) local c=a+b return c*2 end print("ARITHMETIC_OK",calculate(4,5))'
    },
    { name: 'closure-upvalue', source: readFixture('closure-loop-semantics.lua') },
    { name: 'callback-event', source: readFixture('callback-event-public.lua') },
    { name: 'coroutine-metatable-varargs', source: readFixture('advanced-runtime.lua') },
    { name: 'method-metatable', source: readFixture('member-function-declarations.lua') },
    { name: 'typed-luau', source: readFixture('typed-luau-public.lua') },
    { name: 'mentality-ui-controlled', source: readFixture('mentality-ui-mocked.lua') },
    { name: 'infinite-yield-mega', source: readFixture('infinite-yield-style-mocked.lua'), checkpoints: 9 },
    ...[100, 250, 500, 1000].map(functions => ({
        name: `stress-${functions}`,
        source: generateStressCorpus({ functions, seed: `public-beta-${functions}` })
    }))
];

(async () => {
    const results = [];
    for (const fixture of fixtures) {
        const original = await runLuau(fixture.source, `${fixture.name}-original`, { timeoutMs: LIMITS.runtimeTimeoutMs });
        for (const profile of PROFILES) {
            const seed = `public-beta-${fixture.name}-${profile.toLowerCase().replace('+', 'plus')}`;
            let built;
            let runtime;
            try {
                built = await buildSource(fixture.source, profile, seed, LIMITS);
                runtime = await runLuau(built.code, `${fixture.name}-${profile}`, {
                    timeoutMs: LIMITS.runtimeTimeoutMs,
                    metadata: built.build
                });
                assert.strictEqual(runtime.output, original.output, `${profile}/${fixture.name} semantic mismatch`);
                assert(built.build.outputBytes <= LIMITS.maxOutputBytes, `${profile}/${fixture.name} exceeded public output limit`);
                assert(built.buildTimeMs <= LIMITS.buildTimeoutMs, `${profile}/${fixture.name} exceeded public build timeout`);
                if (profile === 'Light' || profile === 'Light+') {
                    assert.strictEqual(built.build.vmRequested, false);
                    assert.strictEqual(built.build.virtualizedFunctions, 0);
                }
                if (profile === 'Good' || profile === 'Pro') {
                    assert(Array.isArray(built.build.selectionDetails));
                    for (const detail of built.build.selectionDetails) {
                        assert(Number.isFinite(detail.protectionValueScore));
                        assert(Number.isFinite(detail.estimatedVmCost));
                        assert(detail.selectionReason, 'selection reason is missing');
                    }
                }
                const checkpointCount = fixture.checkpoints
                    ? runtime.output.split('\n').filter(line => /^IY_.*_OK$/.test(line)).length
                    : (runtime.output ? 1 : 0);
                if (fixture.checkpoints) assert.strictEqual(checkpointCount, fixture.checkpoints);
                results.push({
                    fixture: fixture.name,
                    profile,
                    buildSuccess: true,
                    runtimeSuccess: true,
                    checkpointCount,
                    semanticMismatchCount: 0,
                    discoveredFunctions: built.build.discoveredFunctions,
                    eligibleFunctions: built.build.eligibleFunctions,
                    virtualizedFunctions: built.build.virtualizedFunctions,
                    fallbackFunctions: built.build.fallbackFunctions,
                    unsupportedFunctions: built.build.unsupportedFunctions,
                    budgetLimitedFunctions: built.build.budgetLimitedFunctions,
                    yieldSensitiveFunctions: built.build.yieldSensitiveFunctions,
                    environmentSensitiveFunctions: built.build.environmentSensitiveFunctions,
                    buildTimeMs: Number(built.buildTimeMs.toFixed(2)),
                    outputBytes: built.build.outputBytes,
                    runtimeSlowdown: Number((runtime.runtimeExecutionTimeMs / Math.max(1, original.runtimeExecutionTimeMs)).toFixed(2)),
                    peakRuntimeMemory: runtime.peakRuntimeMemory,
                    runtimeBackend: runtime.runtimeBackend
                });
            } catch (error) {
                saveFailure({
                    seed,
                    profile,
                    source: fixture.source,
                    obfuscated: built?.code || '',
                    metadata: built?.build || {},
                    error,
                    originalOutput: original.output,
                    transformedOutput: runtime?.output || error.stdout || '',
                    runtimeBackend: runtime?.runtimeBackend || error.runtimeBackend,
                    runtimeVersion: runtime?.runtimeVersion || error.runtimeVersion,
                    failingCheckpoint: fixture.name
                });
                throw error;
            }
        }
    }

    const mega = results.filter(result => result.fixture === 'infinite-yield-mega');
    assert(mega.every(result => result.checkpointCount === 9));
    const goodMega = mega.find(result => result.profile === 'Good');
    const proMega = mega.find(result => result.profile === 'Pro');
    assert(goodMega.virtualizedFunctions < proMega.virtualizedFunctions, 'Good and Pro lost their coverage distinction');

    const average = (profile, key) => {
        const rows = results.filter(result => result.profile === profile);
        return rows.reduce((sum, row) => sum + (row[key] || 0), 0) / rows.length;
    };
    assert(average('Light', 'outputBytes') < average('Light+', 'outputBytes'), 'Light must remain smaller than Light+');

    const byProfile = Object.fromEntries(PROFILES.map(profile => {
        const rows = results.filter(result => result.profile === profile);
        return [profile, {
            fixtures: rows.length,
            buildSuccess: rows.filter(row => row.buildSuccess).length,
            runtimeSuccess: rows.filter(row => row.runtimeSuccess).length,
            semanticMismatchCount: rows.reduce((sum, row) => sum + row.semanticMismatchCount, 0),
            virtualizedFunctions: rows.reduce((sum, row) => sum + row.virtualizedFunctions, 0),
            fallbackFunctions: rows.reduce((sum, row) => sum + row.fallbackFunctions, 0),
            maxBuildTimeMs: Math.max(...rows.map(row => row.buildTimeMs)),
            maxOutputBytes: Math.max(...rows.map(row => row.outputBytes)),
            maxRuntimeSlowdown: Math.max(...rows.map(row => row.runtimeSlowdown)),
            peakRuntimeMemory: Math.max(...rows.map(row => row.peakRuntimeMemory || 0))
        }];
    }));
    const report = { profiles: byProfile, results };
    const output = path.join(__dirname, 'tests', 'generated', 'public-beta-matrix.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log('SukaRed public beta profile matrix passed');
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
