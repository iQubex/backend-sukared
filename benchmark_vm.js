const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const { obfuscateDetailed } = require('./server');

const PRO_BUDGET = {
    maxVmInstructions: 6000,
    maxOutputBytes: 2500000,
    maxProcessingTimeMs: 2500,
    maxInterpreterInstances: 64
};

const makeLargeScript = (functionCount) => {
    const declarations = [];
    const calls = [];
    for (let index = 1; index <= functionCount; index++) {
        declarations.push(`function benchmarkFunctions.function${index}(value) return value + ${index} end`);
        calls.push(`total = total + benchmarkFunctions.function${index}(1)`);
    }
    return `local benchmarkFunctions = {}\n${declarations.join('\n')}\nlocal total = 0\n${calls.join('\n')}\nprint(total)`;
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
        const result = JSON.parse(stdout);
        resolve({ output: result.output, elapsedMs: performance.now() - started });
    });
    child.stdin.end(JSON.stringify({ source, chunk }));
});

const medianRuntime = async (source, chunk) => {
    const samples = [];
    let output = '';
    for (let index = 0; index < 3; index++) {
        const result = await runLuau(source, `${chunk}-${index}`);
        output = result.output;
        samples.push(result.elapsedMs);
    }
    samples.sort((a, b) => a - b);
    return { output, elapsedMs: samples[1] };
};

const benchmark = async (functionCount) => {
    if (global.gc) global.gc();
    const source = makeLargeScript(functionCount);
    const memoryBefore = process.memoryUsage();
    let peakHeapUsed = memoryBefore.heapUsed;
    let peakRss = memoryBefore.rss;
    const sampler = setInterval(() => {
        const sample = process.memoryUsage();
        peakHeapUsed = Math.max(peakHeapUsed, sample.heapUsed);
        peakRss = Math.max(peakRss, sample.rss);
    }, 2);
    const buildStarted = performance.now();
    const result = await obfuscateDetailed(source, {
        profile: 'pro',
        seed: `benchmark-${functionCount}`,
        deadCodeProbability: 0,
        devMode: true
    });
    const buildTimeMs = performance.now() - buildStarted;
    clearInterval(sampler);
    const memoryAfter = process.memoryUsage();
    peakHeapUsed = Math.max(peakHeapUsed, memoryAfter.heapUsed);
    peakRss = Math.max(peakRss, memoryAfter.rss);

    const originalRuntime = await medianRuntime(source, `benchmark-original-${functionCount}`);
    const vmRuntime = await medianRuntime(result.code, `benchmark-vm-${functionCount}`);
    assert.strictEqual(vmRuntime.output, originalRuntime.output, `${functionCount}-function runtime output changed`);
    assert(result.build.vmInstructionCount <= PRO_BUDGET.maxVmInstructions, 'VM instruction budget exceeded');
    assert(result.build.outputBytes <= PRO_BUDGET.maxOutputBytes, 'output budget exceeded');
    assert(result.build.processingTimeMs <= PRO_BUDGET.maxProcessingTimeMs, 'processing-time budget exceeded');
    assert(result.build.interpreterInstanceCount <= PRO_BUDGET.maxInterpreterInstances, 'interpreter budget exceeded');

    return {
        functionCount,
        eligibleFunctions: result.build.eligibleFunctions,
        virtualizedFunctions: result.build.virtualizedFunctions,
        buildTimeMs: Number(buildTimeMs.toFixed(2)),
        outputBytes: result.build.outputBytes,
        runtimeOriginalMs: Number(originalRuntime.elapsedMs.toFixed(2)),
        runtimeVmMs: Number(vmRuntime.elapsedMs.toFixed(2)),
        runtimeSlowdown: Number((vmRuntime.elapsedMs / originalRuntime.elapsedMs).toFixed(2)),
        heapPeakDeltaBytes: Math.max(0, peakHeapUsed - memoryBefore.heapUsed),
        rssPeakDeltaBytes: Math.max(0, peakRss - memoryBefore.rss),
        heapAfterBytes: memoryAfter.heapUsed,
        rssAfterBytes: memoryAfter.rss
    };
};

const run = async () => {
    const results = [];
    for (const functionCount of [50, 100, 250]) results.push(await benchmark(functionCount));
    console.log(JSON.stringify({ profile: 'Pro', results }, null, 2));
};

run().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
