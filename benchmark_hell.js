const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { obfuscateDetailed } = require('./server');

const HELL_BUDGET = {
    maxVmInstructions: 15000,
    maxOutputBytes: 6000000,
    maxProcessingTimeMs: 6000,
    maxInterpreterInstances: 32
};

const makeLargeScript = count => {
    const declarations = [];
    const calls = [];
    for (let index = 1; index <= count; index++) {
        declarations.push(`function benchmarkFunctions.function${index}(value) local n=value+${index} return n*2 end`);
        calls.push(`total=total+benchmarkFunctions.function${index}(1)`);
    }
    return `local benchmarkFunctions={}\n${declarations.join('\n')}\nlocal total=0\n${calls.join('\n')}\nprint(total)`;
};

const runLuau = (source, chunk) => new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [path.join(__dirname, 'tests', 'luau_runtime_runner.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => {
        if (code !== 0) return reject(new Error(stderr || `Luau runtime exited with ${code}`));
        resolve({ output: JSON.parse(stdout).output, elapsedMs: performance.now() - started });
    });
    child.stdin.end(JSON.stringify({ source, chunk }));
});

const benchmark = async count => {
    if (global.gc) global.gc();
    const source = makeLargeScript(count);
    const heapBefore = process.memoryUsage().heapUsed;
    let peakHeap = heapBefore;
    const sampler = setInterval(() => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }, 2);
    const started = performance.now();
    const result = await obfuscateDetailed(source, {
        profile: 'strong', vmMode: 'aggressive', hell: true,
        seed: `hell-benchmark-${count}`, maxClusterSize: 16,
        deadCodeProbability: 0, devMode: true, vmBudgets: HELL_BUDGET
    });
    const buildTimeMs = performance.now() - started;
    clearInterval(sampler);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    const original = await runLuau(source, `hell-benchmark-${count}-original`);
    const transformed = await runLuau(result.code, `hell-benchmark-${count}-vm`);
    assert.strictEqual(transformed.output, original.output);
    assert(result.build.vmInstructionCount <= HELL_BUDGET.maxVmInstructions);
    assert(result.build.outputBytes <= HELL_BUDGET.maxOutputBytes);
    assert(result.build.interpreterInstanceCount <= HELL_BUDGET.maxInterpreterInstances);
    return {
        functionCount: count,
        virtualizedFunctions: result.build.virtualizedFunctions,
        clusteredFunctions: result.build.clusteredFunctions,
        dedicatedInterpreterFunctions: result.build.dedicatedInterpreterFunctions,
        sharedInterpreterClusters: result.build.sharedInterpreterClusters,
        interpreterInstanceCount: result.build.interpreterInstanceCount,
        buildTimeMs: Number(buildTimeMs.toFixed(2)),
        outputBytes: result.build.outputBytes,
        runtimeSlowdown: Number((transformed.elapsedMs / original.elapsedMs).toFixed(2)),
        peakHeapDelta: Math.max(0, peakHeap - heapBefore),
        constantPoolSegments: result.build.constantPoolSegments,
        fusedInstructionCount: result.build.fusedInstructionCount,
        splitInstructionCount: result.build.splitInstructionCount,
        shuffledBlockCount: result.build.shuffledBlockCount,
        dispatchFamilyCount: result.build.dispatchFamilyCount,
        fetchFamiliesUsed: result.build.fetchFamiliesUsed,
        constantDecoderFamilies: result.build.constantDecoderFamilies,
        callFamiliesUsed: result.build.callFamiliesUsed
    };
};

(async () => {
    const results = [];
    for (const count of [50, 100, 250]) results.push(await benchmark(count));
    console.log(JSON.stringify({ profile: 'Hell (internal gate)', results }, null, 2));
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
