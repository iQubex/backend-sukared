const emptyVmMetrics = (mode = 'off') => ({
    vmMode: mode,
    selectedFunctions: 0,
    virtualizedFunctions: 0,
    skippedFunctions: 0,
    vmInstructionCount: 0,
    opcodeMap: {},
    branchOrders: [],
    functions: []
});

module.exports = {
    emptyVmMetrics
};
