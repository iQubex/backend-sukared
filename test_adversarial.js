const assert = require('assert');
const { virtualizeSource } = require('./core/vm/virtualizer');
const { compareNormalizedBuilds } = require('./core/adversarial_analyzer');

const source = `
local function add(a, b) return a + b end
local function branch(value) if value > 2 then return value else return 2 end end
local function loop(limit) local sum = 0 for i = 1, limit do sum = sum + i end return sum end
local function callback(prefix) return function(value) return prefix .. value end end
print(add(2, 3), branch(4), loop(3), callback("x")("y"))
`;

const run = async () => {
    const outputs = [];
    const familyOrders = new Set();
    const blockOrders = new Set();
    for (let index = 0; index < 20; index++) {
        const result = await virtualizeSource(source, {
            vmMode: 'selected',
            seed: `normalization-seed-${index}`
        });
        outputs.push(result.code);
        familyOrders.add(result.metrics.interpreterFamiliesUsed.join('|'));
        blockOrders.add(JSON.stringify(result.metrics.blockOrders));
        assert(result.metrics.shuffledBlockCount > 0, `seed ${index} did not shuffle physical blocks`);
        assert(result.metrics.interpreterFamiliesUsed.length >= 3,
            `seed ${index} did not use at least three interpreter families`);
    }
    const comparison = compareNormalizedBuilds(outputs);
    assert(comparison.uniqueNormalizedFingerprints > 1,
        'all twenty builds normalized to one interpreter fingerprint');
    assert(comparison.normalizedSimilarity < 1,
        'normalized fingerprint similarity must be below 1');
    assert(familyOrders.size > 1, 'interpreter family order did not vary across seeds');
    assert(blockOrders.size > 1, 'physical block order did not vary across seeds');
    console.log(JSON.stringify(comparison));
    console.log('SukaRed adversarial tests passed');
};

run().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
