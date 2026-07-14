const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
process.env.SUKARED_HELL_TEST = '1';
const { app, obfuscateDetailed } = require('./server');

const HELL_BUDGET = {
    maxVmInstructions: 15000,
    maxOutputBytes: 6000000,
    maxProcessingTimeMs: 6000,
    maxInterpreterInstances: 32
};

const runLuau = (source, chunk) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'tests', 'luau_runtime_runner.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => {
        if (code !== 0) return reject(new Error(stderr || `Luau runtime exited with ${code}`));
        resolve(JSON.parse(stdout).output);
    });
    child.stdin.end(JSON.stringify({ source, chunk }));
});

const buildHell = (source, seed) => obfuscateDetailed(source, {
    profile: 'strong',
    vmMode: 'aggressive',
    hell: true,
    seed,
    maxClusterSize: 3,
    deadCodeProbability: 0,
    devMode: true,
    vmBudgets: HELL_BUDGET
});

const withServer = callback => new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
        try {
            resolve(await callback(`http://127.0.0.1:${server.address().port}`));
        } catch (error) {
            reject(error);
        } finally {
            server.close();
        }
    });
});

const run = async () => {
    const fixturePath = path.join(__dirname, 'tests', 'regressions', 'hell-hybrid-runtime.lua');
    const source = fs.readFileSync(fixturePath, 'utf8');
    const expected = await runLuau(source, 'hell-hybrid-original');
    const result = await buildHell(source, 'hell-hybrid-production');
    assert.strictEqual(await runLuau(result.code, 'hell-hybrid-vm'), expected);

    const build = result.build;
    assert(build.sharedInterpreterClusters > 0, 'no shared cluster was emitted');
    assert(build.clusteredFunctions > 0, 'no functions were clustered');
    assert(build.dedicatedInterpreterFunctions > 0, 'dedicated fallback was not exercised');
    assert.strictEqual(build.clusteredFunctions + build.dedicatedInterpreterFunctions,
        build.virtualizedFunctions, 'hybrid function accounting invariant failed');
    assert.strictEqual(build.interpreterInstanceCount,
        build.sharedInterpreterClusters + build.dedicatedInterpreterFunctions,
        'interpreter instance accounting invariant failed');
    assert(build.constantPoolSegments > 1, 'constant pools were not segmented');
    assert(build.functionLocalConstantSegments > 0, 'function-local constant segments are absent');
    assert(build.lazyConstantCount > 0, 'lazy constant resolution was not exercised');
    assert.strictEqual(build.decodedAtStartupCount, 0, 'constants decoded eagerly');
    assert(build.fusedInstructionCount > 0, 'no fused instructions were emitted');
    assert(build.splitInstructionCount > 0, 'no split instructions were emitted');
    assert(build.shuffledBlockCount > 0, 'no physical blocks were shuffled');
    assert(build.interpreterFamiliesUsed.length > 1, 'mixed interpreter families were not emitted');
    assert(build.clusterFallbackReasons.some(item => /coroutine\.yield/.test(item.reason)),
        'coroutine/yield dedicated fallback reason was not reported');
    assert(build.clusteredPrototypeFunctions > 0, 'safe nested prototypes were not clustered');
    assert.strictEqual(build.dedicatedPrototypeFunctions, 0, 'safe nested prototypes unexpectedly used dedicated fallback');
    assert(build.outputBytes <= HELL_BUDGET.maxOutputBytes, 'Hell output budget exceeded');
    assert(build.vmInstructionCount <= HELL_BUDGET.maxVmInstructions, 'Hell instruction budget exceeded');

    const fusedSource = fs.readFileSync(path.join(__dirname, 'tests', 'regressions', 'hell-fused-opcodes.lua'), 'utf8');
    const fusedExpected = await runLuau(fusedSource, 'hell-fused-original');
    const fusedBuild = await buildHell(fusedSource, 'hell-fused-production');
    assert.strictEqual(await runLuau(fusedBuild.code, 'hell-fused-vm'), fusedExpected);
    const requiredFusedFamilies = [
        'GET_GLOBAL_CALL', 'GET_TABLE_CALL', 'SELF_CALL', 'COMPARISON_BRANCH',
        'GET_TABLE_COMPARISON', 'GET_UPVALUE_ARITHMETIC', 'CLOSURE_CAPTURE_MOVE'
    ];
    for (const family of requiredFusedFamilies) {
        assert(fusedBuild.build.fusedOpcodeFamilies.includes(family), `missing fused opcode family: ${family}`);
    }
    assert(fusedBuild.build.clusteredPrototypeFunctions > 0, 'nested prototypes were not clustered');

    await withServer(async baseUrl => {
        const response = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: source, profile: 'hell', seed: 'hell-production-endpoint', deadCodeProbability: 0 })
        });
        const payload = await response.json();
        assert.strictEqual(response.status, 200, payload.error || 'Hell production endpoint failed');
        assert.strictEqual(payload.build.publicProfile, 'Hell');
        assert.strictEqual(payload.build.publicProfileStatus, 'Experimental');
        assert(payload.build.sharedInterpreterClusters > 0);
        assert.strictEqual(await runLuau(payload.obfuscated, 'hell-production-endpoint'), expected);
    });

    for (const name of [
        'closure-loop-semantics.lua',
        'member-function-declarations.lua',
        'advanced-runtime.lua',
        'nested-pcall-callback.lua'
    ]) {
        const regression = fs.readFileSync(path.join(__dirname, 'tests', 'regressions', name), 'utf8');
        const original = await runLuau(regression, `hell-${name}-original`);
        const transformed = await buildHell(regression, `hell-${name}`);
        assert.strictEqual(await runLuau(transformed.code, `hell-${name}-vm`), original, `${name} changed behavior`);
    }

    console.log(JSON.stringify({
        runtime: expected,
        virtualizedFunctions: build.virtualizedFunctions,
        clusteredFunctions: build.clusteredFunctions,
        dedicatedInterpreterFunctions: build.dedicatedInterpreterFunctions,
        sharedInterpreterClusters: build.sharedInterpreterClusters,
        interpreterInstanceCount: build.interpreterInstanceCount,
        constantPoolSegments: build.constantPoolSegments,
        fusedInstructionCount: build.fusedInstructionCount,
        splitInstructionCount: build.splitInstructionCount,
        shuffledBlockCount: build.shuffledBlockCount
    }, null, 2));
    console.log('SukaRed Hell hybrid runtime tests passed');
};

run().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
