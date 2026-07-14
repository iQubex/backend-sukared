const assert = require('assert');
const {
    HELL_ENABLED,
    planSharedInterpreterClusters,
    segmentConstantPools,
    getHellPreparationStatus
} = require('./core/vm/hell_preparation');

assert.strictEqual(HELL_ENABLED, false, 'Hell must remain disabled');

const clusters = planSharedInterpreterClusters([
    { name: 'a', interpreterTemplate: 'handler', layout: 'table' },
    { name: 'b', interpreterTemplate: 'handler', layout: 'table' },
    { name: 'c', interpreterTemplate: 'conditional', layout: 'flat' }
], 2);
assert.strictEqual(clusters.length, 2, 'cluster planner did not group compatible interpreters');
assert.deepStrictEqual(clusters[0].functions, ['a', 'b']);

const segmented = segmentConstantPools([[1, 'shared'], ['shared', 2]], 2);
assert.strictEqual(segmented.segments.length, 2);
assert.deepStrictEqual(segmented.references[0][1], segmented.references[1][0], 'shared constant was not deduplicated');

const status = getHellPreparationStatus();
assert.strictEqual(status.enabled, false);
assert.strictEqual(status.ready, false);
assert.strictEqual(status.prerequisites.perFunctionOperandEncoding, 'complete');
console.log('SukaRed Hell preparation tests passed');
