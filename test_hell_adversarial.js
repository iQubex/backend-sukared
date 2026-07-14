const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { virtualizeSource } = require('./core/vm/virtualizer');
const { compareNormalizedBuilds } = require('./core/adversarial_analyzer');
const { analyzeSemanticRecovery } = require('./core/vm/semantic_recovery_analyzer');
const { parse } = require('./core/ast_traverser');

const makeSource = count => {
    const declarations = [];
    const calls = [];
    for (let index = 1; index <= count; index++) {
        declarations.push(`local function f${index}(value) local n=value+${index} return n*2,"constant-${index % 5}" end`);
        calls.push(`local v${index}=f${index}(${index}) total=total+v${index}`);
    }
    declarations.push('local function closureFactory(x) return function(y) return x+y end end');
    declarations.push('local function choose(x) if x>2 then return x else return 2 end end');
    declarations.push('local function sumLoop(n) local s=0 for i=1,n do s=s+i end return s end');
    declarations.push('local object={value=3};function object:add(x) return self.value+x end');
    return `${declarations.join('\n')}\nlocal total=0\n${calls.join('\n')}\nprint(total,closureFactory(2)(3),choose(4),sumLoop(3),object:add(2))`;
};

const ratio = (count, total) => Number((total ? count / total : 0).toFixed(3));
const runLuau = (source, chunk) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'tests', 'luau_runtime_runner.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', code => code === 0 ? resolve(JSON.parse(stdout).output) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify({ source, chunk }));
});

(async () => {
    const outputs = [];
    const clusterShapes = new Set();
    let vmPresenceDetections = 0;
    let interpreterFamilyRecovery = 0;
    let opcodeSemanticRecovery = 0;
    let constantSemanticRecovery = 0;
    let controlFlowSemanticRecovery = 0;
    let callSemanticRecovery = 0;
    let executableSourceRecovery = 0;
    let recoveredSourceParse = 0;
    let recoveredSourceExecution = 0;
    let recoveredBehaviorMatches = 0;
    const dispatchFamilies = new Set();
    const fetchFamilies = new Set();
    const constantFamilies = new Set();
    const callFamilies = new Set();
    const source = makeSource(24);
    const originalOutput = await runLuau(source, 'hell-adversarial-original');

    for (let index = 0; index < 100; index++) {
        const result = await virtualizeSource(source, {
            vmMode: 'aggressive', hell: true, maxClusterSize: 5,
            seed: `hell-adversarial-${index}`,
            budgets: {
                maxVmInstructions: 15000, maxOutputBytes: 6000000,
                maxProcessingTimeMs: 6000, maxInterpreterInstances: 32
            }
        });
        outputs.push(result.code);
        const semantic = analyzeSemanticRecovery(result.code, source, result.metrics.dispatchFamiliesUsed);
        vmPresenceDetections += Number(semantic.vmPresenceDetected);
        interpreterFamilyRecovery += semantic.interpreterFamilyRecoveryRate;
        opcodeSemanticRecovery += semantic.opcodeSemanticRecoveryRate;
        constantSemanticRecovery += semantic.constantSemanticRecoveryRate;
        controlFlowSemanticRecovery += semantic.controlFlowSemanticRecoveryRate;
        callSemanticRecovery += semantic.callSemanticRecoveryRate;
        executableSourceRecovery += Number(semantic.executableSourceRecovered);
        if (semantic.recoveredSource) {
            try {
                parse(semantic.recoveredSource, `semantic-recovery-${index}`);
                recoveredSourceParse += 1;
                const recoveredOutput = await runLuau(semantic.recoveredSource, `semantic-recovery-${index}`);
                recoveredSourceExecution += 1;
                if (recoveredOutput === originalOutput) recoveredBehaviorMatches += 1;
            } catch (_) { /* unsuccessful recovery is part of the measured result */ }
        }
        result.metrics.dispatchFamiliesUsed.forEach(value => dispatchFamilies.add(value));
        result.metrics.fetchFamiliesUsed.forEach(value => fetchFamilies.add(value));
        result.metrics.constantDecoderFamilies.forEach(value => constantFamilies.add(value));
        result.metrics.callFamiliesUsed.forEach(value => callFamilies.add(value));
        assert(result.metrics.fakeOpcodeCount > 0);
        assert(result.metrics.opcodeAliasCount > 0);
        assert(result.metrics.deadStateCount > 0);
        clusterShapes.add(result.metrics.instructionLayouts
            .filter(layout => layout.clustered)
            .map(layout => `${layout.cluster}:${layout.function}`).join('|'));
    }

    const normalized = compareNormalizedBuilds(outputs);
    assert.strictEqual(normalized.uniqueNormalizedFingerprints, 100,
        `expected 100 unique fingerprints, received ${normalized.uniqueNormalizedFingerprints}`);
    assert(normalized.normalizedSimilarity <= 0.05,
        `Hell similarity ${normalized.normalizedSimilarity} exceeded the Pro baseline`);
    assert(clusterShapes.size > 1, 'cluster assignment remained stable across seeds');

    console.log(JSON.stringify({
        ...normalized,
        fingerprints: undefined,
        vmPresenceDetectionRate: ratio(vmPresenceDetections, outputs.length),
        interpreterFamilyRecoveryRate: Number((interpreterFamilyRecovery / outputs.length).toFixed(3)),
        opcodeSemanticRecoveryRate: Number((opcodeSemanticRecovery / outputs.length).toFixed(3)),
        constantSemanticRecoveryRate: Number((constantSemanticRecovery / outputs.length).toFixed(3)),
        controlFlowSemanticRecoveryRate: Number((controlFlowSemanticRecovery / outputs.length).toFixed(3)),
        callSemanticRecoveryRate: Number((callSemanticRecovery / outputs.length).toFixed(3)),
        executableSourceRecoveryRate: ratio(executableSourceRecovery, outputs.length),
        recoveredSourceParseRate: ratio(recoveredSourceParse, outputs.length),
        recoveredSourceExecutionRate: ratio(recoveredSourceExecution, outputs.length),
        recoveredBehaviorMatchRate: ratio(recoveredBehaviorMatches, outputs.length),
        uniqueClusterAssignments: clusterShapes.size,
        dispatchFamiliesUsed: [...dispatchFamilies],
        fetchFamiliesUsed: [...fetchFamilies],
        constantDecoderFamilies: [...constantFamilies],
        callFamiliesUsed: [...callFamilies]
    }, null, 2));
    console.log('SukaRed Hell 100-seed adversarial test passed structural uniqueness gates');
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
