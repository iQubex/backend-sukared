const { VmCompileError } = require('./ir');

const countNodes = (node) => {
    if (!node || typeof node !== 'object') return 0;
    let total = 1;
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const item of value) total += countNodes(item);
        } else if (value && typeof value === 'object' && value.type) {
            total += countNodes(value);
        }
    }
    return total;
};

const isIdentifierParamList = (params = []) => params.every(param => param && param.type === 'Identifier');

const unsupportedReason = (fnNode, limits = {}) => {
    if (!fnNode || fnNode.type !== 'FunctionDeclaration') return 'unsupported node';
    if (!fnNode.isLocal || !fnNode.identifier || fnNode.identifier.type !== 'Identifier') return 'not a local function';
    if (!isIdentifierParamList(fnNode.parameters || [])) return 'varargs or unsupported parameters';
    const nodeCount = countNodes(fnNode);
    if (nodeCount > (limits.maxNodes || 90)) return 'function too large';
    for (const statement of fnNode.body || []) {
        if (!['LocalStatement', 'ReturnStatement'].includes(statement.type)) {
            return `unsupported statement: ${statement.type}`;
        }
    }
    return null;
};

const assertSupported = (fnNode, limits) => {
    const reason = unsupportedReason(fnNode, limits);
    if (reason) throw new VmCompileError(reason);
};

module.exports = {
    countNodes,
    unsupportedReason,
    assertSupported
};
