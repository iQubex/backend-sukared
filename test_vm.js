const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { obfuscateDetailed: productionObfuscateDetailed, app } = require('./server');
const { preprocess } = require('./core/preprocessor');
const { virtualizeSource } = require('./core/vm/virtualizer');
const { validateVmOutput } = require('./core/vm/output_validator');

const obfuscateDetailed = (source, options = {}) => productionObfuscateDetailed(source, {
    ...options,
    vmPostTransform: false
});

const vmPhase1Source = `
local function calc(a, b)
    local c = a + b
    local d = c * 2
    local e = d / 2
    return tonumber(e - 1)
end

print(calc(6, 2))
`;

const productionAcceptanceSource = `local function calculate(a, b)
    local c = a + b
    return c * 2
end

print(calculate(4, 5))`;

const fallbackSource = `
local function supported(a, b)
    return a + b
end

local function unsupported(a)
    if a > 1 then
        return a
    end
    return 0
end

print(supported(2, 5))
`;

const upvalueAndLogicalSource = `
local count = 0
local calls = 0
local function increment()
    count = count + 1
    return count
end
local function readCount()
    return count
end
local function factorial(n)
    if n <= 1 then return 1 end
    return n * factorial(n - 1)
end
local function sideEffect()
    calls = calls + 1
    return true
end
print(increment(), increment(), readCount(), factorial(5), false and sideEffect(), true or sideEffect(), calls)
`;

const phase3LoopSource = `
local function values()
    return 1, 2, nil, 4
end
local function pass(...)
    local count = select("#", ...)
    return count, ...
end
local function runLoops(values)
    local sum = 0
    local i = 0
    while i < 3 do
        i = i + 1
        if i > 0 then sum = sum + i end
    end
    repeat
        sum = sum - 1
    until sum == 3
    for n = 1, 5, 2 do
        if n == 3 then break end
        sum = sum + n
    end
    for _, value in pairs(values) do
        sum = sum + value
    end
    return sum
end
local a, b, c, d = values()
local count, x, y, z = pass(10, nil, 30)
local packed = {values()}
print(runLoops({a = 2, b = 3}), a, b, c == nil, d, count, x, y == nil, z, packed[1], packed[3] == nil, packed[4])
`;

const phase4ClosureSource = `
local function makeCounter()
    local value = 0
    return function()
        value = value + 1
        return value
    end
end

local function makePair()
    local shared = 0
    local function increment()
        shared = shared + 1
    end
    local function read()
        return shared
    end
    return increment, read
end

local function factorial(n)
    local function fact(x)
        if x <= 1 then return 1 end
        return x * fact(x - 1)
    end
    return fact(n)
end

local function makeLoopClosures()
    local functions = {}
    for i = 1, 3 do
        functions[i] = function()
            return i
        end
    end
    return functions
end

local even, odd
even = function(n)
    if n == 0 then return true end
    return odd(n - 1)
end
odd = function(n)
    if n == 0 then return false end
    return even(n - 1)
end

local counter = makeCounter()
assert(counter() == 1 and counter() == 2)
local increment, read = makePair()
increment()
assert(read() == 1)
assert(factorial(5) == 120)
local loopClosures = makeLoopClosures()
assert(loopClosures[1]() == 1 and loopClosures[2]() == 2 and loopClosures[3]() == 3)
local callbacks = { run = function(value) return value * 2 end }
assert(callbacks.run(6) == 12)
assert(even(10) == true and odd(9) == true)
print("phase4-ok")
`;

const closureSemanticsSource = fs.readFileSync(
    path.join(__dirname, 'tests', 'regressions', 'closure-loop-semantics.lua'),
    'utf8'
);

const memberFunctionDeclarationsSource = fs.readFileSync(
    path.join(__dirname, 'tests', 'regressions', 'member-function-declarations.lua'),
    'utf8'
);

const advancedRuntimeSource = fs.readFileSync(
    path.join(__dirname, 'tests', 'regressions', 'advanced-runtime.lua'),
    'utf8'
);

const makeProfileBudgetSource = (count) => {
    const declarations = [];
    const calls = [];
    for (let index = 1; index <= count; index++) {
        declarations.push(`local function profileFunction${index}(value) return value + ${index} end`);
        calls.push(`total = total + profileFunction${index}(1)`);
    }
    return `${declarations.join('\n')}\nlocal total = 0\n${calls.join('\n')}\nprint(total)`;
};

const PROFILE_BUDGETS = {
    good: { maxVmInstructions: 1200, maxOutputBytes: 750000, maxProcessingTimeMs: 1200, maxInterpreterInstances: 12 },
    pro: { maxVmInstructions: 6000, maxOutputBytes: 2500000, maxProcessingTimeMs: 2500, maxInterpreterInstances: 64 }
};

const phase2Cases = [
    {
        name: 'operand-order',
        source: `
local function calculate(a, b)
    local sub = a - b
    local div = a / b
    return sub, div
end
local x, y = calculate(10, 2)
assert(x == 8 and y == 5)
print("operand-order-ok")
`
    },
    {
        name: 'tables',
        source: `
local function tableOps(key, a, b)
    local values = { base = 10 }
    values[key] = a - b
    values.ratio = a / b
    return values[key], values.ratio, nil
end
local x, y, z = tableOps("answer", 10, 2)
assert(x == 8 and y == 5 and z == nil)
print("tables-ok")
`
    },
    {
        name: 'method-self-once',
        source: `
Counter = {}
function Counter:add(amount)
    self.value = self.value + amount
    return self.value
end
counter = setmetatable({ value = 10 }, { __index = Counter })
evaluations = 0
function getCounter()
    evaluations = evaluations + 1
    return counter
end
local function invoke(amount)
    return getCounter():add(amount)
end
local result = invoke(5)
assert(result == 15 and counter.value == 15 and evaluations == 1)
print("method-ok")
`
    },
    {
        name: 'multiple-call-results',
        source: `
function resultSource()
    return 4, nil, 6
end
local function receive()
    local a, b, c = resultSource()
    return a, b, c
end
local a, b, c = receive()
assert(a == 4 and b == nil and c == 6)
print("multiple-ok")
`
    },
    {
        name: 'vararg-forwarding',
        source: `
function collect(...)
    return ...
end
local function forward(...)
    return collect(...)
end
local a, b, c = forward(1, nil, 3)
assert(a == 1 and b == nil and c == 3)
print("vararg-ok")
`
    }
];

const robloxCoverageSource = `
game = {}
function game:GetService(name)
    return { Name = name }
end

task = {}
task.spawn = function(callback)
    callback()
end

local function buildWidget(parent, key)
    local widget = { Parent = parent }
    widget[key] = "ready"
    return widget, widget[key]
end

local function getPlayers()
    return game:GetService("Players")
end

local function updateWidget(widget, enabled)
    if enabled then
        widget.Visible = true
    end
    return widget
end

local function scheduleWidget(widget)
    task.spawn(function()
        widget.Ready = true
    end)
    return widget
end

local function makeCallback(prefix)
    return function(value)
        return prefix .. value
    end
end

local widget, state = buildWidget("Root", "State")
local players = getPlayers()
updateWidget(widget, true)
scheduleWidget(widget)
local callback = makeCallback("item-")
assert(widget.Parent == "Root" and state == "ready")
assert(widget.Visible == true and widget.Ready == true)
assert(players.Name == "Players" and callback("ok") == "item-ok")
print("roblox-coverage-ok")
`;

const anonymousCallbackSource = `
task = { spawn = function(callback) callback() end }
local callbacks = {
    Toggle = function(value)
        print("toggle", value)
    end,
    Spawn = function()
        task.spawn(function()
            print("spawned")
        end)
    end,
}
callbacks.Toggle(5)
callbacks.Spawn()
return nil
`;

const runLuau = async (source, chunk = 'vm-test') => {
    const runner = path.join(__dirname, 'tests', 'luau_runtime_runner.mjs');
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error(stderr || `Luau runtime exited with ${code}`));
            try { resolve(JSON.parse(stdout).output); } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify({ source, chunk }));
    });
};

const withProductionServer = async (callback) => {
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
        const address = server.address();
        return await callback(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
};

const run = async () => {
    await withProductionServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: productionAcceptanceSource, profile: 'good', seed: 'route-acceptance' })
        });
        assert.strictEqual(response.status, 200, `Good production route returned ${response.status}`);
        const payload = await response.json();
        const build = payload.build;
        assert.strictEqual(build.vmRequested, true, 'production route did not request VM');
        assert.strictEqual(build.vmApplied, true, 'production route did not apply VM');
        assert(build.discoveredFunctions >= 1, 'production route discovered no functions');
        assert(build.virtualizedFunctions >= 1, 'production route virtualized no functions');
        assert(build.vmInstructionCount >= 1, 'production route emitted no VM instructions');
        assert(!/local\s+function\s+calculate/.test(payload.obfuscated), 'production output retained calculate declaration');
        assert(!/local\s+c\s*=\s*a\s*\+\s*b/.test(payload.obfuscated), 'production output retained calculate body');
        const structure = validateVmOutput(payload.obfuscated);
        assert.strictEqual(structure.valid, true, 'production output has no structural VM');
        assert.strictEqual(structure.hasBytecode, true, 'production output has no bytecode');
        assert.strictEqual(structure.hasInstructionPointer, true, 'production output has no instruction pointer');
        assert.strictEqual(structure.hasRegisters, true, 'production output has no virtual registers');
        assert.strictEqual(structure.hasOpcodeDispatch, true, 'production output has no opcode dispatch');
        assert.strictEqual(await runLuau(payload.obfuscated, 'production-route-acceptance'), '18');

        const rejected = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: `local function onlyBranch() do local value = 1 end return 0 end`, profile: 'good' })
        });
        assert.strictEqual(rejected.status, 200, 'Good zero-coverage build must use safe fallback');
        const rejectedPayload = await rejected.json();
        assert.strictEqual(rejectedPayload.build.vmRequested, true);
        assert.strictEqual(rejectedPayload.build.vmApplied, false);
        assert.strictEqual(rejectedPayload.build.vmInstructionCount, 0);
        assert.strictEqual(rejectedPayload.build.vmReason, 'No compatible functions were found.');
        assert.strictEqual(rejectedPayload.build.fallbackFunctions, 1);
        assert(rejectedPayload.build.skipReasons.some(item => item.function === 'onlyBranch'));
        assert.strictEqual(await runLuau(rejectedPayload.obfuscated, 'good-safe-fallback'), '');

        const functionless = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: `print("")`, profile: 'good' })
        });
        assert.strictEqual(functionless.status, 200, 'Good must accept valid scripts with no function declarations');
        const functionlessPayload = await functionless.json();
        assert.strictEqual(functionlessPayload.build.vmRequested, true);
        assert.strictEqual(functionlessPayload.build.vmApplied, false);
        assert.strictEqual(functionlessPayload.build.discoveredFunctions, 0);
        assert.strictEqual(functionlessPayload.build.vmInstructionCount, 0);
        assert.strictEqual(functionlessPayload.build.vmReason, 'No function declarations were found; VM was not needed.');

        const nestedFixture = fs.readFileSync(
            path.join(__dirname, 'tests', 'regressions', 'nested-pcall-callback.lua'),
            'utf8'
        );
        const nestedResponse = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: nestedFixture, profile: 'good' })
        });
        assert.strictEqual(nestedResponse.status, 200, 'nested pcall callback failed through production endpoint');
        const nestedPayload = await nestedResponse.json();
        assert.strictEqual(nestedPayload.build.skippedFunctions, 0, 'nested pcall callback was skipped');
        assert(nestedPayload.build.virtualizedFunctions >= 1, 'nested pcall callback was not virtualized');
        assert.strictEqual(nestedPayload.build.functionDeclarationSkips, 0, 'FunctionDeclaration rejection remains');
        assert(!nestedPayload.obfuscated.includes('https://discord.gg/rcbBdzfJT4'), 'nested callback body remained readable');

        const loopResponse = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: phase3LoopSource, profile: 'good' })
        });
        assert.strictEqual(loopResponse.status, 200, 'Phase 3 loops failed through production endpoint');
        const loopPayload = await loopResponse.json();
        assert.strictEqual(loopPayload.build.skippedFunctions, 0, 'Phase 3 loop function was skipped');
        assert.strictEqual(loopPayload.build.virtualizedFunctions, 3, 'Phase 3 functions were not virtualized');
        for (const opcode of ['FOR_PREP', 'FOR_LOOP', 'ITER_PREP', 'ITER_NEXT', 'JUMP', 'JUMP_IF']) {
            assert(loopPayload.report.opcodeMap[opcode], `Phase 3 opcode ${opcode} is missing`);
        }
        assert.strictEqual(await runLuau(loopPayload.obfuscated, 'production-route-phase3-loops'),
            '9 1 2 true 4 3 10 true 30 1 true 4');

        const closureResponse = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: phase4ClosureSource, profile: 'good', seed: 'phase4-closures' })
        });
        assert.strictEqual(closureResponse.status, 200, 'Phase 4 closures failed through production endpoint');
        const closurePayload = await closureResponse.json();
        assert.strictEqual(closurePayload.build.skippedFunctions, 0, 'Phase 4 closure function was skipped');
        assert(closurePayload.build.nestedFunctionsVirtualized >= 5, 'nested closures were not virtualized');
        assert(closurePayload.build.closuresCreated >= 5, 'closure cells were not created');
        assert(closurePayload.build.capturedUpvalues >= 5, 'captured upvalues were not reported');
        assert.strictEqual(closurePayload.build.interpreterFamiliesUsed.length, 4,
            'Phase 4 production build did not use all interpreter families');
        assert.strictEqual(closurePayload.build.interpreterInstanceCount,
            closurePayload.build.dedicatedInterpreterCount,
            'dedicated interpreter metadata is inconsistent');
        assert.strictEqual(closurePayload.build.sharedInterpreterCount, 0);
        assert(closurePayload.build.shuffledBlockCount > 0, 'production VM did not shuffle physical blocks');
        assert(closurePayload.build.constantPoolStrategies.includes('function-local-shuffled-v1'),
            'function-specific constant pool strategy is missing');
        assert(closurePayload.build.operandEncodings.includes('affine-field-v1'),
            'per-function operand encoding is missing');
        assert(closurePayload.build.fusedInstructionCount > 0, 'production VM emitted no fused instructions');
        assert(closurePayload.build.splitInstructionCount > 0, 'production VM emitted no split instructions');
        assert.strictEqual(await runLuau(closurePayload.obfuscated, 'production-route-phase4-closures'), 'phase4-ok');

        const semanticsResponse = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: closureSemanticsSource,
                profile: 'pro',
                seed: 'closure-semantics-pro-route',
                deadCodeProbability: 0
            })
        });
        assert.strictEqual(semanticsResponse.status, 200, 'closure semantics failed through production endpoint');
        const semanticsPayload = await semanticsResponse.json();
        assert.strictEqual(semanticsPayload.build.skippedFunctions, 0, 'Pro closure semantics skipped VM functions');
        assert(semanticsPayload.report.opcodeMap.RESET_CELL, 'loop closure build has no RESET_CELL opcode');
        assert.strictEqual(
            await runLuau(semanticsPayload.obfuscated, 'production-route-closure-semantics'),
            'closure-semantics-ok'
        );

        const memberResponse = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: memberFunctionDeclarationsSource,
                profile: 'pro',
                seed: 'member-function-declarations',
                deadCodeProbability: 0
            })
        });
        assert.strictEqual(memberResponse.status, 200, 'member declarations failed through production endpoint');
        const memberPayload = await memberResponse.json();
        assert.strictEqual(memberPayload.build.excludedFunctions, 0, 'supported member declarations were excluded');
        assert.strictEqual(memberPayload.build.excludedCallbacks, 0, 'callbacks nested in methods were excluded');
        assert.strictEqual(
            memberPayload.build.virtualizedFunctions + memberPayload.build.eligibleSkippedFunctions,
            memberPayload.build.eligibleFunctions,
            'member declaration metadata invariant failed'
        );
        assert.strictEqual(
            await runLuau(memberPayload.obfuscated, 'production-route-member-declarations'),
            'member-declarations-ok'
        );

        const advancedResponse = await fetch(`${baseUrl}/obfuscate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: advancedRuntimeSource,
                profile: 'pro',
                seed: 'advanced-runtime',
                deadCodeProbability: 0
            })
        });
        assert.strictEqual(advancedResponse.status, 200, 'advanced runtime failed through production endpoint');
        const advancedPayload = await advancedResponse.json();
        assert.strictEqual(
            advancedPayload.build.virtualizedFunctions + advancedPayload.build.eligibleSkippedFunctions,
            advancedPayload.build.eligibleFunctions,
            'advanced runtime metadata invariant failed'
        );
        assert.strictEqual(
            advancedPayload.build.budgetLimitedFunctions
                + advancedPayload.build.budgetLimitedCallbacks
                + advancedPayload.build.unsupportedFunctions
                + advancedPayload.build.unsupportedCallbacks,
            advancedPayload.build.excludedFunctions,
            'advanced runtime exclusion categories overlap or omit candidates'
        );
        assert.strictEqual(
            await runLuau(advancedPayload.obfuscated, 'production-route-advanced-runtime'),
            'advanced-runtime-ok'
        );
    });

    const budgetLimitedBuild = await obfuscateDetailed(phase4ClosureSource, {
        profile: 'strong',
        vmMode: 'aggressive',
        seed: 'budget-limited-closures',
        vmBudgets: {
            maxVmInstructions: 10000,
            maxOutputBytes: 2500000,
            maxProcessingTimeMs: 2500,
            maxInterpreterInstances: 2
        },
        deadCodeProbability: 0,
        devMode: true
    });
    assert(budgetLimitedBuild.build.eligibleSkippedFunctions > 0, 'low VM budget did not exclude eligible functions');
    assert(budgetLimitedBuild.build.budgetLimitedFunctions + budgetLimitedBuild.build.budgetLimitedCallbacks > 0,
        'low VM budget did not classify budget-limited candidates');
    assert.strictEqual(budgetLimitedBuild.build.unsupportedFunctions + budgetLimitedBuild.build.unsupportedCallbacks, 0,
        'supported budget fixture was incorrectly classified as unsupported');
    assert.strictEqual(
        budgetLimitedBuild.build.virtualizedFunctions + budgetLimitedBuild.build.eligibleSkippedFunctions,
        budgetLimitedBuild.build.eligibleFunctions,
        'budget-limited metadata invariant failed'
    );
    assert.strictEqual(await runLuau(budgetLimitedBuild.code, 'budget-limited-closures'), 'phase4-ok');

    const unsupportedCategorySource = `
local function supported(value) return value + 1 end
local function unsupportedNamed() do local value = 1 end return value end
pcall(function() do local callbackValue = 1 end return callbackValue end)
print(supported(4))
`;
    const unsupportedCategoryBuild = await obfuscateDetailed(unsupportedCategorySource, {
        profile: 'pro', seed: 'unsupported-categories', deadCodeProbability: 0, devMode: true
    });
    assert.strictEqual(unsupportedCategoryBuild.build.unsupportedFunctions, 1);
    assert.strictEqual(unsupportedCategoryBuild.build.unsupportedCallbacks, 1);
    assert.strictEqual(unsupportedCategoryBuild.build.budgetLimitedFunctions, 0);
    assert.strictEqual(unsupportedCategoryBuild.build.budgetLimitedCallbacks, 0);
    assert.strictEqual(unsupportedCategoryBuild.build.excludedFunctions, 2,
        'unsupported callbacks were double-counted in exclusion total');
    assert.strictEqual(await runLuau(unsupportedCategoryBuild.code, 'unsupported-categories'), '5');

    const profileBudgetSource = makeProfileBudgetSource(34);
    const profileExpected = await runLuau(profileBudgetSource, 'profile-budget-original');
    const goodBudgetBuild = await obfuscateDetailed(profileBudgetSource, {
        profile: 'good', seed: 'profile-budget-good', deadCodeProbability: 0, devMode: true
    });
    const proBudgetBuild = await obfuscateDetailed(profileBudgetSource, {
        profile: 'pro', seed: 'profile-budget-pro', deadCodeProbability: 0, devMode: true
    });
    assert(goodBudgetBuild.build.virtualizedFunctions <= PROFILE_BUDGETS.good.maxInterpreterInstances,
        'Good exceeded its interpreter budget');
    assert(goodBudgetBuild.build.virtualizedFunctions < proBudgetBuild.build.virtualizedFunctions,
        'Good must remain more selective than Pro');
    assert(goodBudgetBuild.build.outputBytes < proBudgetBuild.build.outputBytes,
        'Good output should remain lighter than Pro for the profile fixture');
    assert.strictEqual(proBudgetBuild.build.virtualizedFunctions, proBudgetBuild.build.eligibleFunctions,
        'Pro did not target maximum eligible coverage');
    for (const [profile, result] of [['good', goodBudgetBuild], ['pro', proBudgetBuild]]) {
        const budget = PROFILE_BUDGETS[profile];
        assert(result.build.vmInstructionCount <= budget.maxVmInstructions, `${profile} exceeded VM instruction budget`);
        assert(result.build.outputBytes <= budget.maxOutputBytes, `${profile} exceeded output budget`);
        assert(result.build.processingTimeMs <= budget.maxProcessingTimeMs, `${profile} exceeded processing-time budget`);
        assert(result.build.interpreterInstanceCount <= budget.maxInterpreterInstances, `${profile} exceeded interpreter budget`);
        assert.strictEqual(result.build.virtualizedFunctions + result.build.eligibleSkippedFunctions,
            result.build.eligibleFunctions, `${profile} metadata invariant failed`);
        assert.strictEqual(result.build.budgetLimitedFunctions + result.build.budgetLimitedCallbacks
            + result.build.unsupportedFunctions + result.build.unsupportedCallbacks,
        result.build.excludedFunctions, `${profile} exclusion categories overlap or omit candidates`);
        assert.strictEqual(await runLuau(result.code, `profile-budget-${profile}`), profileExpected);
    }
    assert.strictEqual(goodBudgetBuild.build.unsupportedFunctions + goodBudgetBuild.build.unsupportedCallbacks, 0,
        'Good profile fixture should be limited only by budget');

    const nestedPrototypeSource = `
local function invoke()
    return pcall(function()
        setclipboard("https://discord.gg/rcbBdzfJT4")
    end)
end
print(invoke())
`;
    const nestedPrototype = await obfuscateDetailed(nestedPrototypeSource, {
        profile: 'good',
        seed: 'nested-prototype',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(nestedPrototype.build.skippedFunctions, 0, 'nested prototype build skipped a function');
    assert(nestedPrototype.build.nestedFunctionsDiscovered >= 1, 'nested function was not discovered');
    assert(nestedPrototype.build.nestedFunctionsVirtualized >= 1, 'nested function was not virtualized as a prototype');
    assert(nestedPrototype.build.closuresCreated >= 1, 'CLOSURE was not emitted');
    assert.strictEqual(nestedPrototype.build.functionDeclarationSkips, 0);
    assert(nestedPrototype.report.opcodeMap.CLOSURE, 'nested callback build has no CLOSURE opcode');
    assert.strictEqual(nestedPrototype.build.vmFunctionCount, nestedPrototype.build.virtualizedFunctions,
        'VM function count does not match virtualizedFunctions');
    assert.strictEqual(nestedPrototype.build.interpreterInstanceCount, nestedPrototype.build.virtualizedFunctions,
        'interpreter instance count does not match virtualizedFunctions');
    assert.strictEqual(nestedPrototype.build.instructionLayout.length, nestedPrototype.build.virtualizedFunctions,
        'layout records do not match virtualizedFunctions');
    assert.strictEqual(nestedPrototype.build.nestedVmFunctionCount, nestedPrototype.build.nestedFunctionsVirtualized,
        'nested VM function count is inconsistent');

    const original = await runLuau(vmPhase1Source, 'vm-original');
    assert.strictEqual(original, '7');

    const selectedA = await obfuscateDetailed(vmPhase1Source, {
        profile: 'strong',
        vmMode: 'selected',
        seed: 'seed-a',
        deadCodeProbability: 0,
        devMode: true
    });
    const selectedB = await obfuscateDetailed(vmPhase1Source, {
        profile: 'strong',
        vmMode: 'selected',
        seed: 'seed-b',
        deadCodeProbability: 0,
        devMode: true
    });
    const selectedC = await obfuscateDetailed(vmPhase1Source, {
        profile: 'strong',
        vmMode: 'selected',
        seed: 'layout-2',
        deadCodeProbability: 0,
        devMode: true
    });

    assert.notStrictEqual(selectedA.code, selectedB.code, 'two VM seeds should produce different output');
    assert.notStrictEqual(selectedB.code, selectedC.code, 'three VM seeds should produce different output');
    assert.notDeepStrictEqual(selectedA.report.opcodeMap, selectedB.report.opcodeMap, 'two VM seeds should produce different opcode maps');
    assert.notDeepStrictEqual(selectedB.report.opcodeMap, selectedC.report.opcodeMap, 'three VM seeds should produce different opcode maps');
    assert.notDeepStrictEqual(selectedA.report.branchOrders, selectedB.report.branchOrders, 'two VM seeds should produce different interpreter branch order');
    const layoutSignatures = [selectedA, selectedB, selectedC].map(result => JSON.stringify(result.report.instructionLayout));
    assert.strictEqual(new Set(layoutSignatures).size, 3, 'three VM seeds should produce distinct instruction layout signatures');
    assert.strictEqual(selectedA.build.virtualizedFunctions, 1, 'selected mode should virtualize one supported function');
    assert.strictEqual(selectedA.build.vmApplied, true, 'build metadata should report VM applied only when functions are virtualized');
    assert.strictEqual(selectedA.build.selectedFunctions, 1, 'build metadata should include selectedFunctions');
    assert(selectedA.build.vmInstructionCount >= 9, 'VM Phase 1 should emit real instructions');
    assert.strictEqual(selectedA.build.interpreterTemplate, 'conditional-register-v1', 'build metadata should report interpreter template');
    assert(Array.isArray(selectedA.build.instructionLayout), 'build metadata should report instruction layout');
    assert(!Object.hasOwn(selectedA.report.vmFunctions[0], 'constants'), 'public VM report must not expose decoded constants');
    assert(!Object.hasOwn(selectedA.report.vmFunctions[0], 'bytecode'), 'public VM report must not expose bytecode payloads');
    assert(!/loadstring\s*\(/i.test(selectedA.code), 'VM output must not wrap the whole script with loadstring');
    assert(!/local\s+function\s+calc\s*\(/.test(selectedA.code), 'selected function declaration remained visible');
    assert(!/local\s+c\s*=\s*a\s*\+\s*b/.test(selectedA.code), 'selected function body local add remained visible');
    assert(!/local\s+d\s*=\s*c\s*\*\s*2/.test(selectedA.code), 'selected function body multiplication remained visible');
    assert(!/return\s+tonumber\s*\(\s*e\s*-\s*1\s*\)/.test(selectedA.code), 'selected function return body remained visible');
    assert(/while true do/.test(selectedA.code), 'generated VM output should include an interpreter loop');
    assert.strictEqual(await runLuau(selectedA.code, 'vm-selected-a'), original);
    assert.strictEqual(await runLuau(selectedB.code, 'vm-selected-b'), original);
    assert.strictEqual(await runLuau(selectedC.code, 'vm-selected-c'), original);

    const preprocessed = await preprocess(vmPhase1Source);
    const rawVm = await virtualizeSource(preprocessed, { vmMode: 'selected', seed: 'seed-a' });
    assert(!/local\s+c\s*=\s*a\s*\+\s*b/.test(rawVm.code), 'original function body remained visible after VM transform');
    assert(/while true do/.test(rawVm.code), 'interpreter loop was not generated');
    assert(/\{[0-9,\s]+\}/.test(rawVm.code), 'bytecode array was not generated');
    assert(rawVm.metrics.functions[0].ir.some(inst => inst.op === 'LOAD_CONST'), 'IR should include LOAD_CONST');
    assert(rawVm.metrics.functions[0].ir.some(inst => inst.op === 'ADD'), 'IR should include ADD');
    assert(rawVm.metrics.functions[0].ir.some(inst => inst.op === 'CALL'), 'IR should include CALL');
    assert(rawVm.metrics.functions[0].bytecode.length > 0, 'encoded bytecode should be recorded');

    const runtimeLayouts = new Map();
    for (let i = 0; i < 100 && runtimeLayouts.size < 3; i++) {
        const candidate = await virtualizeSource(preprocessed, {
            vmMode: 'selected',
            seed: `layout-runtime-${i}`
        });
        const layout = candidate.metrics.instructionLayouts[0].layout;
        if (!runtimeLayouts.has(layout)) runtimeLayouts.set(layout, candidate.code);
    }
    assert.deepStrictEqual(
        [...runtimeLayouts.keys()].sort(),
        ['flat', 'segmented', 'table'],
        'all instruction storage layouts should be generated'
    );
    for (const [layout, code] of runtimeLayouts) {
        assert.strictEqual(await runLuau(code, `vm-layout-${layout}`), original, `${layout} layout changed behavior`);
    }

    for (const testCase of phase2Cases) {
        const expected = await runLuau(testCase.source, `${testCase.name}-original`);
        for (const seed of ['phase2-a', 'phase2-b', 'phase2-c']) {
            const result = await obfuscateDetailed(testCase.source, {
                profile: 'good',
                seed: `${seed}:${testCase.name}`,
                deadCodeProbability: 0,
                devMode: true
            });
            assert(result.build.virtualizedFunctions > 0, `${testCase.name}: no function was virtualized`);
            assert.strictEqual(result.build.publicProfile, 'Good', `${testCase.name}: public profile metadata is wrong`);
            assert.strictEqual(result.build.internalProfile, 'strong', `${testCase.name}: internal profile metadata is wrong`);
            assert(result.build.eligibleFunctions >= result.build.virtualizedFunctions, `${testCase.name}: function coverage counts are invalid`);
            assert(result.build.eligibleAstNodes >= result.build.virtualizedAstNodes, `${testCase.name}: AST coverage counts are invalid`);
            assert(result.build.functionCoveragePercent > 0, `${testCase.name}: function coverage was not calculated`);
            assert(result.build.astCoveragePercent > 0, `${testCase.name}: AST coverage was not calculated`);
            const actual = await runLuau(result.code, `${testCase.name}-${seed}`);
            assert.strictEqual(
                actual,
                expected,
                `${testCase.name}: behavior changed for ${seed}`
            );
        }
    }

    const expectedPhase2Ops = {
        tables: ['NEW_TABLE', 'GET_TABLE', 'SET_TABLE', 'LOAD_NIL'],
        'method-self-once': ['SELF', 'CALL'],
        'multiple-call-results': ['CALL', 'RETURN'],
        'vararg-forwarding': ['VARARG', 'CALL', 'RETURN']
    };
    for (const testCase of phase2Cases.filter(item => expectedPhase2Ops[item.name])) {
        const phase2Raw = await virtualizeSource(await preprocess(testCase.source), {
            vmMode: 'aggressive',
            seed: `phase2-ir:${testCase.name}`
        });
        const ops = new Set(phase2Raw.metrics.functions
            .filter(fn => fn.status === 'virtualized')
            .flatMap(fn => fn.ir.map(inst => inst.op)));
        for (const expectedOp of expectedPhase2Ops[testCase.name]) {
            assert(ops.has(expectedOp), `${testCase.name}: ${expectedOp} was not emitted into IR`);
        }
    }

    const robloxExpected = await runLuau(robloxCoverageSource, 'roblox-coverage-original');
    const robloxBuild = await obfuscateDetailed(robloxCoverageSource, {
        profile: 'good',
        seed: 'roblox-coverage-seed',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(await runLuau(robloxBuild.code, 'roblox-coverage-vm'), robloxExpected);
    assert.strictEqual(robloxBuild.build.vmRequested, true, 'Good must report VM requested');
    assert.strictEqual(robloxBuild.build.vmApplied, true, 'compatible Roblox functions should apply VM');
    assert(robloxBuild.build.vmInstructionCount > 0, 'Roblox coverage build emitted no VM instructions');
    assert(/while true do/.test(robloxBuild.code), 'applied VM output has no interpreter loop');
    assert(robloxBuild.build.interpreterTemplate.includes('conditional-register-v1'), 'conditional interpreter metadata is missing');
    assert(robloxBuild.build.interpreterFamiliesUsed.length >= 3, 'real build did not mix at least three interpreter families');
    assert.strictEqual(robloxBuild.build.dedicatedInterpreterCount, robloxBuild.build.interpreterInstanceCount);
    assert(robloxBuild.build.instructionLayout.length > 0, 'applied VM output has no bytecode layout');
    assert(Object.values(robloxBuild.report.opcodeMap).some(opcode => robloxBuild.code.includes(String(opcode))), 'applied VM output has no encoded opcodes');
    assert(/local function buildWidget/.test(robloxCoverageSource), 'coverage fixture is invalid');
    assert(!/local function buildWidget/.test(robloxBuild.code), 'virtualized Roblox function body remained visible');
    const robloxSkipped = new Map(robloxBuild.build.skipReasons.map(item => [item.function, item.reason]));
    assert(robloxBuild.build.virtualizedFunctions >= 2, 'Roblox coverage did not improve after branch/upvalue support');

    const callbackExpected = await runLuau(anonymousCallbackSource, 'anonymous-callback-original');
    const callbackBuild = await obfuscateDetailed(anonymousCallbackSource, {
        profile: 'good',
        seed: 'anonymous-callback-seed',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(await runLuau(callbackBuild.code, 'anonymous-callback-vm'), callbackExpected);
    assert(callbackBuild.build.discoveredFunctions >= 3, 'anonymous callbacks were not discovered');
    assert(callbackBuild.build.virtualizedFunctions >= 2, 'compatible anonymous callbacks were not virtualized');
    assert(callbackBuild.build.vmInstructionCount > 0, 'anonymous callback VM emitted no instructions');
    assert(callbackBuild.build.functionCoveragePercent > 0, 'anonymous callback coverage was not reported');
    assert(!/Toggle\s*=\s*function\s*\(value\)/.test(callbackBuild.code), 'anonymous callback body remained readable');

    const upvalueExpected = await runLuau(upvalueAndLogicalSource, 'upvalue-logical-original');
    const upvalueBuild = await productionObfuscateDetailed(upvalueAndLogicalSource, {
        profile: 'good',
        seed: 'upvalue-logical-seed',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(await runLuau(upvalueBuild.code, 'upvalue-logical-vm'), upvalueExpected);
    assert.strictEqual(upvalueBuild.build.skippedFunctions, 0, 'supported upvalue/logical functions were skipped');
    const upvalueOps = new Set(upvalueBuild.report.vmFunctions.flatMap(fn => (fn.ir || []).map(inst => inst.op)));
    assert(upvalueBuild.report.opcodeMap.GET_UPVALUE, 'GET_UPVALUE opcode is missing');
    assert(upvalueBuild.report.opcodeMap.SET_UPVALUE, 'SET_UPVALUE opcode is missing');

    const noCompatibleSource = `
local function branchOnly(value)
    do local ignored = value end
    return 0
end
print(branchOnly(true))
`;
    const noCompatibleBuild = await obfuscateDetailed(noCompatibleSource, {
        profile: 'good',
        seed: 'no-compatible',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(noCompatibleBuild.build.vmApplied, false);
    assert.strictEqual(noCompatibleBuild.build.fallbackFunctions, 1);
    assert(noCompatibleBuild.build.skipReasons.some(item =>
        item.function === 'branchOnly' && item.reason === 'unsupported statement: DoStatement'));
    assert.strictEqual(await runLuau(noCompatibleBuild.code, 'good-direct-safe-fallback'), '0');

    const aggressive = await obfuscateDetailed(fallbackSource, {
        profile: 'strong',
        vmMode: 'aggressive',
        seed: 'seed-c',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(await runLuau(aggressive.code, 'vm-aggressive'), '7');
    assert(aggressive.build.virtualizedFunctions >= 1, 'aggressive mode should virtualize supported function');
    assert(aggressive.build.functionCoveragePercent > 0, 'aggressive mode should report coverage');

    const noVm = await obfuscateDetailed(fallbackSource, {
        profile: 'balanced',
        vmMode: 'off',
        seed: 'seed-no-vm',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(noVm.build.virtualizedFunctions, 0, 'vm off should not virtualize functions');
    assert.strictEqual(noVm.build.vmApplied, false, 'frontend metadata must not claim VM was applied when no functions were virtualized');

    let strictFailed = false;
    try {
        await obfuscateDetailed(`local function unsupported(v) do local x=v end end`, {
            profile: 'strong',
            vmMode: 'selected',
            vmStrict: true,
            seed: 'seed-strict',
            deadCodeProbability: 0,
            devMode: true
        });
    } catch (err) {
        strictFailed = /SukaRed VM error|unsupported/.test(err.message);
    }
    assert(strictFailed, 'vm-strict should fail when a selected function is unsupported');

    const proClosureBuild = await obfuscateDetailed(closureSemanticsSource, {
        profile: 'pro',
        seed: 'pro-closure-semantics',
        deadCodeProbability: 0,
        devMode: true
    });
    assert.strictEqual(proClosureBuild.build.skippedFunctions, 0, 'Pro closure regression skipped functions');
    assert.strictEqual(await runLuau(proClosureBuild.code, 'pro-closure-semantics'), 'closure-semantics-ok');

    const proBuild = await obfuscateDetailed(vmPhase1Source, { profile: 'pro', seed: 'pro-experimental' });
    assert.strictEqual(proBuild.build.publicProfile, 'Pro');
    assert.strictEqual(proBuild.build.publicProfileStatus, 'Experimental');
    assert.strictEqual(proBuild.build.vmMode, 'aggressive');
    assert.strictEqual(proBuild.build.vmApplied, true);

    console.log('SukaRed VM tests passed');
};

run().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
