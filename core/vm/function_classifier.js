const YIELD_NAMES = new Set([
    'yield', 'wait', 'WaitForChild', 'task.wait', 'coroutine.yield'
]);
const ENVIRONMENT_NAMES = new Set([
    '_G', 'shared', 'getgenv', 'getfenv', 'setfenv', 'getrenv', 'getgc'
]);
const CALLBACK_NAMES = new Set([
    'Connect', 'Once', 'spawn', 'defer', 'delay', 'pcall', 'xpcall', 'newcclosure',
    'hookfunction', 'hookmetamethod'
]);
const HOT_LOOP_NAMES = new Set(['RenderStepped', 'Heartbeat', 'Stepped', 'BindToRenderStep']);

const expressionName = node => {
    if (!node) return '';
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression') {
        const base = expressionName(node.base);
        return base ? `${base}.${node.identifier?.name || ''}` : node.identifier?.name || '';
    }
    if (node.type === 'IndexExpression') return expressionName(node.base);
    return '';
};

const analyzeFunction = (node, context = {}) => {
    const stats = {
        branchCount: 0,
        loopCount: 0,
        callCount: 0,
        meaningfulConstantCount: 0,
        yieldSensitive: false,
        environmentSensitive: false,
        callbackLike: false,
        hotLoop: false
    };
    const visit = current => {
        if (!current || typeof current !== 'object') return;
        if (current !== node && current.type === 'FunctionDeclaration') return;
        if (current.type === 'IfStatement') stats.branchCount += Math.max(1, (current.clauses || []).length - 1);
        if (['WhileStatement', 'RepeatStatement', 'ForNumericStatement', 'ForGenericStatement'].includes(current.type)) {
            stats.loopCount += 1;
        }
        if (current.type === 'StringLiteral' && String(current.value || '').length >= 4) stats.meaningfulConstantCount += 1;
        if (current.type === 'NumericLiteral' && Number(current.value) !== 0 && Number(current.value) !== 1) {
            stats.meaningfulConstantCount += 1;
        }
        if (current.type === 'Identifier' && ENVIRONMENT_NAMES.has(current.name)) stats.environmentSensitive = true;
        if (current.type === 'CallExpression') {
            stats.callCount += 1;
            const fullName = expressionName(current.base);
            const tail = fullName.split('.').pop();
            if (YIELD_NAMES.has(fullName) || YIELD_NAMES.has(tail)) stats.yieldSensitive = true;
            if (ENVIRONMENT_NAMES.has(fullName) || ENVIRONMENT_NAMES.has(tail)) stats.environmentSensitive = true;
            if (HOT_LOOP_NAMES.has(tail)) stats.hotLoop = true;
        }
        for (const value of Object.values(current)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object' && value.type) visit(value);
        }
    };
    visit(node);

    const callSiteName = expressionName(context.parentNode?.base);
    const callSiteTail = callSiteName.split('.').pop();
    stats.callbackLike = context.isAnonymous && (
        (context.parentNode?.type === 'CallExpression' && CALLBACK_NAMES.has(callSiteTail))
        || ['TableKeyString', 'TableKey', 'TableValue'].includes(context.parentNode?.type)
        || (context.parentNode?.type === 'LocalStatement' && context.parentKey === 'init')
        || (context.parentNode?.type === 'AssignmentStatement' && context.parentKey === 'init')
    );
    if (HOT_LOOP_NAMES.has(callSiteTail)) stats.hotLoop = true;
    return stats;
};

const countReferences = (ast, names) => {
    const counts = new Map([...names].map(name => [name, 0]));
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'Identifier' && counts.has(node.name)) counts.set(node.name, counts.get(node.name) + 1);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object' && value.type) visit(value);
        }
    };
    visit(ast);
    return counts;
};

const scoreCandidate = (candidate, referenceCount = 0) => {
    const stats = candidate.analysis;
    let value = candidate.nodeCount;
    value += stats.branchCount * 18;
    value += stats.loopCount * 22;
    value += Math.min(stats.meaningfulConstantCount, 8) * 5;
    value += Math.min(referenceCount, 6) * 8;
    value += stats.callbackLike ? 36 : 0;
    value += candidate.isNonLocal ? 18 : 0;
    value += candidate.isAnonymous ? 6 : 0;
    if (candidate.nodeCount <= 12 && !stats.branchCount && !stats.loopCount) value -= 24;
    if (stats.hotLoop) value -= 50;
    if (stats.yieldSensitive) value -= 35;
    const estimatedVmCost = Math.max(1, Math.ceil(candidate.nodeCount * 0.65));
    const reasons = [];
    if (stats.callbackLike) reasons.push('callback');
    if (stats.branchCount || stats.loopCount) reasons.push('control-flow');
    if (stats.meaningfulConstantCount) reasons.push('meaningful-constants');
    if (referenceCount > 1) reasons.push('multi-reference');
    if (candidate.nodeCount <= 12) reasons.push('tiny-wrapper');
    if (stats.hotLoop) reasons.push('hot-loop-deprioritized');
    if (stats.yieldSensitive) reasons.push('yield-sensitive');
    if (stats.environmentSensitive) reasons.push('environment-sensitive');
    return {
        protectionValueScore: Math.max(0, value),
        estimatedVmCost,
        selectionReason: reasons.length ? reasons.join(', ') : 'general-logic'
    };
};

module.exports = { analyzeFunction, countReferences, scoreCandidate, expressionName };
