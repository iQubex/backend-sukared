const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runLuau, buildSource, DEFAULT_LIMITS } = require('./tests/stress_harness');
const { assertNoCompleteLogicalMap } = require('./core/vm/pc_transition_validator');

(async () => {
    const fixture = path.join(__dirname, 'tests', 'regressions', 'pc-remap-high-risk.lua');
    const source = fs.readFileSync(fixture, 'utf8');
    const original = await runLuau(source, 'pc-remap-original');
    const results = [];
    for (const seed of ['pc-remap-a', 'pc-remap-b', 'pc-remap-c']) {
        const built = await buildSource(source, 'Hell', seed, DEFAULT_LIMITS);
        const transformed = await runLuau(built.code, `pc-remap-${seed}`);
        assert.strictEqual(transformed.output, original.output, `runtime mismatch for ${seed}`);
        assert.strictEqual(built.build.completeLogicalMapEmitted, false);
        assert(built.build.transitionStructureCount >= 2, 'fallthrough transitions are not segmented');
        assert(built.build.validatedPhysicalPcFunctions > 0, 'physical PC graph was not validated');
        assert(built.build.physicalBranchTargetCount > 0, 'branch targets were not remapped');
        assert(built.build.physicalBackwardEdgeCount > 0, 'backward loop edges were not retained');
        assert(assertNoCompleteLogicalMap(built.code).valid);
        results.push({
            seed,
            virtualizedFunctions: built.build.virtualizedFunctions,
            validatedPhysicalPcFunctions: built.build.validatedPhysicalPcFunctions,
            physicalBranchTargetCount: built.build.physicalBranchTargetCount,
            physicalBackwardEdgeCount: built.build.physicalBackwardEdgeCount,
            transitionStructureCount: built.build.transitionStructureCount,
            outputBytes: built.build.outputBytes
        });
    }
    console.log(JSON.stringify({ runtime: original.output, results }, null, 2));
    console.log('SukaRed physical PC remap tests passed');
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
