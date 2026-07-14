const { validateVmOutput } = require('./output_validator');

const extractSourceStrings = source => [...String(source).matchAll(/(["'])(.*?)\1/g)]
    .map(match => match[2])
    .filter(value => value.length > 0);

const decodeConstantCandidates = code => {
    const recovered = new Set();
    const pattern = /\{1,\{((?:\d+,?)+)\},(\d+),(\d+)\}/g;
    let match;
    while ((match = pattern.exec(String(code)))) {
        const encoded = match[1].split(',').filter(Boolean).map(Number);
        const key = Number(match[2]);
        const mode = Number(match[3]);
        let bytes;
        if (mode === 2) bytes = encoded.map(byte => byte ^ key);
        else if (mode === 3) bytes = [...encoded].reverse().map(byte => (byte - key + 256) % 256);
        else if (mode === 4) bytes = encoded.map((byte, index) => (byte - key - index - 1 + 512) % 256);
        else bytes = encoded.map(byte => (byte - key + 256) % 256);
        try { recovered.add(Buffer.from(bytes).toString('utf8')); } catch (_) { /* invalid candidate */ }
    }
    return recovered;
};

const detectInterpreterFamilies = code => {
    const text = String(code);
    const families = new Set();
    if (/local handlers=\{\}/.test(text)) families.add('handler-table');
    if (/local stateMap=\{/.test(text) && /repeat/.test(text)) families.add('state-machine');
    if (/local stateMap=\{/.test(text)) families.add('computed-state');
    if (/local route=/.test(text)) families.add('mixed');
    if (/if dispatchToken==/.test(text) && /else if dispatchToken==/.test(text)) families.add('nested');
    if (/repeat if dispatchToken==/.test(text)) families.add('segmented');
    if (/if dispatchToken==/.test(text)) families.add('if-chain');
    return families;
};

const recoverOpcodeSemantics = code => {
    const signatures = {
        arithmetic: /get\(b\)[+\-*/]get\(c\)/,
        global: /env\[resolve\(b\)\]/,
        table: /get\(b\)\[get\(c\)\]/,
        method: /receiver\[get\(c\)\]\(receiver\)/,
        comparison: /get\(b\)[<>=~]=?get\(c\)/,
        closure: /desc\[9\]\[spec\[1\]\]/,
        call: /multi=out\.n/,
        return: /return unpack\(/
    };
    return Object.entries(signatures).filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
};

const expectedCallNames = source => {
    const names = new Set();
    for (const match of String(source).matchAll(/(?:\b|[.:])(\w+)\s*\(/g)) {
        if (!['if', 'for', 'while', 'function', 'return', 'assert'].includes(match[1])) names.add(match[1]);
    }
    return names;
};

const ratio = (matched, total) => total ? matched / total : 0;

const analyzeSemanticRecovery = (code, originalSource, expectedFamilies = []) => {
    const recoveredConstants = decodeConstantCandidates(code);
    const sourceConstants = [...new Set(extractSourceStrings(originalSource))];
    const constantsMatched = sourceConstants.filter(value => recoveredConstants.has(value)).length;
    const calls = [...expectedCallNames(originalSource)];
    const callsMatched = calls.filter(name => recoveredConstants.has(name)
        || new RegExp(`\\b${name}\\s*\\(`).test(code)).length;
    const detectedFamilies = detectInterpreterFamilies(code);
    const familyMatches = expectedFamilies.filter(family => {
        const normalized = String(family).replace(/-(?:cluster|dispatch)-v\d+$/, '').replace(/-v\d+$/, '');
        return [...detectedFamilies].some(value => normalized.includes(value) || value.includes(normalized));
    }).length;
    const opcodeSemantics = recoverOpcodeSemantics(code);
    const expectedOpcodeGroups = ['arithmetic', 'global', 'table', 'method', 'comparison', 'closure', 'call', 'return']
        .filter(group => {
            if (group === 'method') return /:\w+\s*\(/.test(originalSource);
            if (group === 'closure') return /function\s*\(/.test(originalSource) || /return\s+function/.test(originalSource);
            if (group === 'comparison') return /(?:==|~=|<=|>=|<|>)/.test(originalSource);
            if (group === 'arithmetic') return /[+\-*/]/.test(originalSource);
            return true;
        });
    const opcodeMatches = expectedOpcodeGroups.filter(group => opcodeSemantics.includes(group)).length;
    const expectsControlFlow = /\b(?:if|for|while|repeat)\b/.test(originalSource);
    const recoveredControlFlow = /pcmap|dispatchState|dispatchToken/.test(code)
        && /(?:_BRANCH|pc=a|pc=d|FOR_LOOP|ITER_NEXT)/.test(code);

    // This conservative analyzer only emits source when readable original function bodies survive.
    const sourceFunctions = [...String(originalSource).matchAll(/(?:local\s+)?function\s+([\w.:]+)/g)].map(match => match[1]);
    const readableFunctions = sourceFunctions.filter(name => new RegExp(`function\\s+${name.replace('.', '\\.')}\\s*\\(`).test(code));
    const recoveredSource = sourceFunctions.length > 0 && readableFunctions.length === sourceFunctions.length
        ? readableFunctions.map(name => `function ${name}(...) end`).join('\n')
        : null;

    return {
        vmPresenceDetected: validateVmOutput(code).valid,
        interpreterFamilyRecoveryRate: ratio(familyMatches, expectedFamilies.length),
        opcodeSemanticRecoveryRate: ratio(opcodeMatches, expectedOpcodeGroups.length),
        constantSemanticRecoveryRate: ratio(constantsMatched, sourceConstants.length),
        controlFlowSemanticRecoveryRate: expectsControlFlow ? Number(recoveredControlFlow) : 0,
        callSemanticRecoveryRate: ratio(callsMatched, calls.length),
        executableSourceRecovered: Boolean(recoveredSource),
        recoveredSource,
        recoveredConstants: [...recoveredConstants],
        recoveredOpcodeSemantics: opcodeSemantics,
        recoveredFunctionBoundaries: readableFunctions.length,
        expectedFunctionBoundaries: sourceFunctions.length
    };
};

module.exports = { analyzeSemanticRecovery, decodeConstantCandidates };
