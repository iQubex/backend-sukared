const assert = require('assert');
const luaparse = require('luaparse');
const { obfuscate } = require('./server');

const sample = `
local function score(x: number)
    local label = \`Score {"OK"}\`
    if x > 10 then
        return string.format("%s:%d", label, x)
    end
    return tostring(x)
end
print(game:GetService("Players"), math.sqrt(16), score(12))
`;

const parseLuau = (code) => luaparse.parse(code, { comments: false, luaVersion: '5.2' });

const run = async () => {
    for (const profile of ['light', 'balanced', 'strong']) {
        const code = await obfuscate(sample, { profile, useVm: profile === 'strong' });
        assert(!/Score OK|GetService|Players/.test(code), `${profile}: source constants leaked`);
        assert(!/[\r\n]/.test(code), `${profile}: output is not single-line`);
        parseLuau(code);
    }

    const digitFree = await obfuscate(sample, { profile: 'strong', digitFree: true, useVm: true });
    assert(!/[0-9]/.test(digitFree), 'digit-free profile emitted a digit');
    assert(!/[\r\n]/.test(digitFree), 'digit-free output is not single-line');
    parseLuau(digitFree);

    const a = await obfuscate(sample, { profile: 'balanced' });
    const b = await obfuscate(sample, { profile: 'balanced' });
    assert.notStrictEqual(a, b, 'two builds should not be identical');

    console.log('SukaRed tests passed');
};

run().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
