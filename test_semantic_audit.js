const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildSource, runLuau, saveFailure } = require('./tests/stress_harness');

const FIXTURES = path.join(__dirname, 'tests', 'regressions');
const profiles = ['Good', 'Pro', 'Hell'];

const normalizedError = error => ({
    output: String(error.stdout || '').trim(),
    semanticMessage: /semantic-boom/.test(String(error.message || error.stderr || ''))
        ? 'semantic-boom'
        : String(error.message || error.stderr || '').trim()
});

const expectRuntimeError = async (source, chunk) => {
    try {
        await runLuau(source, chunk);
    } catch (error) {
        return normalizedError(error);
    }
    throw new Error(`${chunk} unexpectedly completed without an error`);
};

(async () => {
    const source = fs.readFileSync(path.join(FIXTURES, 'semantic-audit.lua'), 'utf8');
    const errorSource = fs.readFileSync(path.join(FIXTURES, 'semantic-error.lua'), 'utf8');
    const original = await runLuau(source, 'semantic-audit-original');
    const originalError = await expectRuntimeError(errorSource, 'semantic-error-original');
    assert.strictEqual(originalError.output, 'before,inside');
    assert.strictEqual(originalError.semanticMessage, 'semantic-boom');

    const results = [];
    for (const profile of profiles) {
        const seed = `semantic-audit-${profile.toLowerCase()}`;
        let build;
        try {
            build = await buildSource(source, profile, seed);
            const runtime = await runLuau(build.code, `semantic-audit-${profile}`, { metadata: build.build });
            assert.strictEqual(runtime.output, original.output, `${profile} semantic output mismatch`);

            const errorBuild = await buildSource(errorSource, profile, `${seed}-error`);
            const transformedError = await expectRuntimeError(errorBuild.code, `semantic-error-${profile}`);
            assert.deepStrictEqual(transformedError, originalError, `${profile} error/side-effect mismatch`);
            results.push({
                profile,
                outputMatched: true,
                sideEffectsMatched: true,
                errorMatched: true,
                virtualizedFunctions: build.build.virtualizedFunctions,
                vmInstructionCount: build.build.vmInstructionCount,
                runtimeBackend: runtime.runtimeBackend,
                runtimeVersion: runtime.runtimeVersion
            });
        } catch (error) {
            saveFailure({
                seed,
                profile,
                source,
                obfuscated: build?.code || '',
                metadata: build?.build || {},
                error,
                originalOutput: original.output,
                transformedOutput: error.stdout || '',
                runtimeBackend: error.runtimeBackend,
                runtimeVersion: error.runtimeVersion,
                failingCheckpoint: 'SEMANTIC_AUDIT'
            });
            throw error;
        }
    }

    console.log(JSON.stringify({ originalOutput: original.output, profiles: results }, null, 2));
    console.log('SukaRed semantic audit passed');
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
