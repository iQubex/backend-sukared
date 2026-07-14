const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runLuau, buildSource, DEFAULT_LIMITS } = require('./tests/stress_harness');

(async () => {
    const fixture = path.join(__dirname, 'tests', 'regressions', 'infinite-yield-style-mocked.lua');
    const source = fs.readFileSync(fixture, 'utf8');
    const expectedCheckpoints = [
        'IY_STARTUP_OK', 'IY_SERVICES_OK', 'IY_GUI_OK', 'IY_EVENTS_OK',
        'IY_COMMANDS_OK', 'IY_ALIASES_OK', 'IY_PLUGINS_OK',
        'IY_COROUTINES_OK', 'IY_FINAL_OK'
    ];
    const original = await runLuau(source, 'iy-mega-original');
    assert.deepStrictEqual(original.output.split('\n'), expectedCheckpoints);
    const results = [];
    for (const seed of ['iy-mega-a', 'iy-mega-b', 'iy-mega-c']) {
        const built = await buildSource(source, 'Hell', seed, DEFAULT_LIMITS);
        const transformed = await runLuau(built.code, seed);
        assert.strictEqual(transformed.output, original.output, `mega fixture mismatch for ${seed}`);
        results.push({ seed, checkpoints: transformed.output.split('\n'), virtualizedFunctions: built.build.virtualizedFunctions });
    }
    console.log(JSON.stringify({ fixture: 'infinite-yield-style-mocked.lua', results }, null, 2));
    console.log('SukaRed mocked mega fixture passed');
})().catch(error => {
    error.code = error.code || 'MEGA_FIXTURE_FAILURE';
    error.failureCategory = 'MEGA_FIXTURE_FAILURE';
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
