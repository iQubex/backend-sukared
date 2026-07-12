const { unsupportedReason, countNodes } = require('./compatibility');

const getLimits = (mode) => ({
    maxFunctions: mode === 'aggressive' ? 8 : 3,
    maxNodes: mode === 'aggressive' ? 180 : 90
});

const shouldConsider = (node) => node
    && node.type === 'FunctionDeclaration'
    && node.isLocal
    && node.identifier
    && node.identifier.type === 'Identifier';

const selectFunctions = (ast, options = {}) => {
    const mode = options.vmMode || 'off';
    const limits = getLimits(mode);
    const selected = [];
    const skipped = [];

    if (mode === 'off') return { selected, skipped, limits };

    for (const node of ast.body || []) {
        if (!shouldConsider(node)) continue;
        const reason = unsupportedReason(node, limits);
        if (reason) {
            skipped.push({
                name: node.identifier.name,
                reason,
                nodeCount: countNodes(node)
            });
            if (options.strict) {
                const error = new Error(`SukaRed VM error: ${node.identifier.name}: ${reason}`);
                error.stage = 'vm-selection';
                throw error;
            }
            continue;
        }
        if (selected.length >= limits.maxFunctions) {
            skipped.push({
                name: node.identifier.name,
                reason: 'skipped: vm_max_functions',
                nodeCount: countNodes(node)
            });
            continue;
        }
        selected.push(node);
    }

    return { selected, skipped, limits };
};

module.exports = {
    selectFunctions,
    getLimits
};
