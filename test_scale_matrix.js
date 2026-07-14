const fs = require('fs');
const path = require('path');
const { run } = require('./tests/stress_runner');

const quick = process.argv.includes('--quick');
const sizes = [100, 250, 500, 1000, 2000];

(async () => {
    const started = new Date().toISOString();
    const reports = [];
    const failures = [];
    for (const functions of sizes) {
        const seed = `beta-matrix-${functions}`;
        try {
            const report = await run({ functions, seed, quick, profiles: ['Good', 'Pro', 'Hell'] });
            reports.push(report);
        } catch (error) {
            failures.push({ functions, seed, code: error.code || 'UNKNOWN', message: error.message });
        }
    }

    const allResults = reports.flatMap(report => report.results);
    const expectedPerSize = quick ? 3 : 20;
    const report = {
        started,
        completed: new Date().toISOString(),
        mode: quick ? 'smoke' : 'acceptance',
        seedPolicy: quick ? { Good: 1, Pro: 1, Hell: 1 } : { Good: 5, Pro: 5, Hell: 10 },
        expectedBuilds: sizes.length * expectedPerSize,
        passedBuilds: allResults.length,
        failedSizes: failures,
        semanticMismatchCount: failures.filter(item => item.code === 'RUNTIME_MISMATCH').length,
        budgetFallbackCount: reports.reduce((sum, item) => sum + item.budgetFallbackCount, 0),
        maxima: allResults.length ? {
            buildTimeMs: Math.max(...allResults.map(item => item.buildTimeMs)),
            outputBytes: Math.max(...allResults.map(item => item.outputBytes)),
            runtimeSlowdown: Math.max(...allResults.map(item => item.runtimeSlowdown)),
            peakRuntimeMemory: Math.max(...allResults.map(item => item.peakRuntimeMemory || 0)),
            estimatedRuntimeHeap: Math.max(...allResults.map(item => item.estimatedRuntimeHeap || 0))
        } : null,
        bySize: reports.map(item => ({
            functionCount: item.functionCount,
            passes: item.passes,
            failures: item.failures,
            budgetFallbackCount: item.budgetFallbackCount,
            maxima: item.maxima
        }))
    };
    const outputPath = path.join(__dirname, 'tests', 'generated', `scale-matrix-${quick ? 'smoke' : 'acceptance'}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (failures.length || report.passedBuilds !== report.expectedBuilds) {
        const error = new Error(`scale matrix incomplete: ${report.passedBuilds}/${report.expectedBuilds} builds passed`);
        error.code = 'SCALE_MATRIX_FAILURE';
        throw error;
    }
    console.log('SukaRed scale matrix passed');
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
