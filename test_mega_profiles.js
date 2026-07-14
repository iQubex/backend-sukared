const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runLuau, buildSource, DEFAULT_LIMITS } = require('./tests/stress_harness');

(async () => {
    const fixture = path.join(__dirname, 'tests', 'regressions', 'infinite-yield-style-mocked.lua');
    const source = fs.readFileSync(fixture, 'utf8');
    const expected = await runLuau(source, 'mega-profile-original');
    const expectedCheckpoints = expected.output.split('\n');
    assert.strictEqual(expectedCheckpoints.length, 9);
    const results = [];
    for (const profile of ['Good', 'Pro', 'Hell']) {
        const built = await buildSource(source, profile, `mega-profile-${profile.toLowerCase()}`, DEFAULT_LIMITS);
        const runtime = await runLuau(built.code, `mega-profile-${profile.toLowerCase()}`, { metadata: built.build });
        assert.strictEqual(runtime.output, expected.output, `${profile} changed mega fixture behavior`);
        const build = built.build;
        results.push({
            profile,
            discoveredFunctions: build.discoveredFunctions,
            eligibleFunctions: build.eligibleFunctions,
            selectedFunctions: build.selectedFunctions,
            virtualizedFunctions: build.virtualizedFunctions,
            fallbackFunctions: build.eligibleSkippedFunctions,
            buildTimeMs: Number(built.buildTimeMs.toFixed(2)),
            outputBytes: build.outputBytes,
            runtimeCompileTimeMs: Number((runtime.runtimeCompileTimeMs || 0).toFixed(2)),
            runtimeExecutionTimeMs: Number(runtime.runtimeExecutionTimeMs.toFixed(2)),
            peakRuntimeMemory: runtime.peakRuntimeMemory,
            functionCoveragePercent: build.functionCoveragePercent,
            astCoveragePercent: build.astCoveragePercent,
            checkpointPassCount: runtime.output.split('\n').filter((line, index) => line === expectedCheckpoints[index]).length
        });
    }
    assert(results[0].virtualizedFunctions < results[1].virtualizedFunctions, 'Good must remain lighter than Pro');
    assert(results[1].virtualizedFunctions <= results[2].virtualizedFunctions, 'Hell must target maximum safe coverage');
    console.log(JSON.stringify({ checkpoints: expectedCheckpoints, results }, null, 2));
    console.log('SukaRed mega profile comparison passed');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
