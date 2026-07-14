const { generateStressCorpus } = require('./tests/generate_vm_stress_corpus');
const { runLuau, buildSource, classifyFailure } = require('./tests/stress_harness');
const { limitsForFunctionCount } = require('./tests/stress_runner');

const parseList = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    return index < 0 ? fallback : process.argv[index + 1].split(',').map(value => value.trim());
};

(async () => {
    const counts = parseList('--counts', ['1000', '2000']).map(Number);
    const profiles = parseList('--profiles', ['Good', 'Pro', 'Hell']);
    const results = [];
    for (const functionCount of counts) {
        const seed = `large-native-${functionCount}`;
        const source = generateStressCorpus({ functions: functionCount, seed });
        const limits = limitsForFunctionCount(functionCount);
        const original = await runLuau(source, `${seed}-original`, { timeoutMs: limits.runtimeTimeoutMs });
        for (const profile of profiles) {
            const buildSeed = `${seed}-${profile.toLowerCase()}`;
            try {
                const built = await buildSource(source, profile, buildSeed, limits);
                const runtime = await runLuau(built.code, buildSeed, {
                    timeoutMs: limits.runtimeTimeoutMs,
                    metadata: built.build
                });
                if (runtime.output !== original.output) {
                    const error = new Error('large benchmark runtime output mismatch');
                    error.code = 'RUNTIME_MISMATCH';
                    throw error;
                }
                results.push({
                    functionCount,
                    profile,
                    status: 'passed',
                    virtualizedFunctions: built.build.virtualizedFunctions,
                    eligibleFunctions: built.build.eligibleFunctions,
                    clusteredFunctions: built.build.clusteredFunctions,
                    outputSize: built.build.outputBytes,
                    buildTimeMs: Number(built.buildTimeMs.toFixed(2)),
                    runtimeCompileTimeMs: Number((runtime.runtimeCompileTimeMs || 0).toFixed(2)),
                    runtimeExecutionTimeMs: Number(runtime.runtimeExecutionTimeMs.toFixed(2)),
                    peakBuildHeap: built.peakHeapDelta,
                    peakRuntimeMemory: runtime.peakRuntimeMemory,
                    estimatedRuntimeHeap: runtime.estimatedRuntimeHeap,
                    runtimeBackend: runtime.runtimeBackend,
                    runtimeVersion: runtime.runtimeVersion
                });
            } catch (error) {
                results.push({
                    functionCount,
                    profile,
                    status: 'failed',
                    failureCategory: classifyFailure(error),
                    message: error.message
                });
            }
        }
    }
    console.log(JSON.stringify({ counts, profiles, results }, null, 2));
    if (results.some(result => result.status !== 'passed')) process.exitCode = 1;
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
