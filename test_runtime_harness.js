const assert = require('assert');
const fs = require('fs');
const os = require('os');
const {
    detectRuntimeBackends, estimateRuntimeResources, classifyRuntimeError, runLuau
} = require('./tests/runtime_harness');

(async () => {
    const tempEntriesBefore = new Set(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('sukared-luau-')));
    const backends = detectRuntimeBackends();
    assert(backends.web.available, 'luau-web fallback is unavailable');
    assert(backends.native, 'native Luau CLI was not detected');

    const native = await runLuau('print("native-runtime-ok")', 'runtime-native');
    assert.strictEqual(native.output, 'native-runtime-ok');
    assert.notStrictEqual(native.runtimeBackend, 'luau-web');
    assert(native.runtimeCompileTimeMs >= 0);
    assert(native.runtimeExecutionTimeMs >= 0);
    assert(native.peakRuntimeMemory > 0);

    const previous = process.env.SUKARED_USE_NATIVE_LUAU;
    process.env.SUKARED_USE_NATIVE_LUAU = '0';
    try {
        const web = await runLuau('print("web-runtime-ok")', 'runtime-web');
        assert.strictEqual(web.output, 'web-runtime-ok');
        assert.strictEqual(web.runtimeBackend, 'luau-web');

        const large = `-- capacity fixture\n${'local x=1\n'.repeat(70000)}`;
        let capacityError = null;
        try { await runLuau(large, 'runtime-web-capacity'); } catch (error) { capacityError = error; }
        assert(capacityError, 'large luau-web input was not rejected by policy');
        assert.strictEqual(classifyRuntimeError(capacityError), 'RUNTIME_OOM');
    } finally {
        if (previous === undefined) delete process.env.SUKARED_USE_NATIVE_LUAU;
        else process.env.SUKARED_USE_NATIVE_LUAU = previous;
    }

    const estimates = estimateRuntimeResources('local function f() return 1 end\nf()', {
        vmInstructionCount: 8,
        totalProtectedConstants: 2,
        virtualizedFunctions: 1
    });
    assert.strictEqual(estimates.estimatedInstructionObjects, 8);
    assert.strictEqual(estimates.estimatedConstantObjects, 2);
    assert.strictEqual(estimates.estimatedClosureObjects, 1);
    assert(estimates.estimatedRuntimeHeap > estimates.sourceBytes);
    const leakedTempEntries = fs.readdirSync(os.tmpdir())
        .filter(name => name.startsWith('sukared-luau-') && !tempEntriesBefore.has(name));
    assert.deepStrictEqual(leakedTempEntries, [], 'runtime harness leaked temporary source directories');

    console.log(JSON.stringify({
        nativeRuntime: {
            backend: native.runtimeBackend,
            version: native.runtimeVersion,
            peakRuntimeMemory: native.peakRuntimeMemory,
            limits: native.runtimeLimits
        },
        webFallback: backends.web,
        estimates,
        temporaryFileCleanup: true
    }, null, 2));
    console.log('SukaRed multi-runtime harness tests passed');
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
