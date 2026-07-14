class VmCompileError extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}

const createContext = (params = []) => ({
    constants: [],
    constantMap: new Map(),
    instructions: [],
    prototypes: [],
    closureSpecs: [],
    registers: 0,
    bindings: new Map(),
    params
});

const allocRegister = (ctx) => {
    ctx.registers += 1;
    return ctx.registers;
};

const addConstant = (ctx, value) => {
    const key = `${typeof value}:${String(value)}`;
    if (ctx.constantMap.has(key)) return ctx.constantMap.get(key);
    ctx.constants.push(value);
    const index = ctx.constants.length;
    ctx.constantMap.set(key, index);
    return index;
};

const emit = (ctx, op, a = 0, b = 0, c = 0, d = 0) => {
    ctx.instructions.push({ op, a, b, c, d });
    return ctx.instructions.length;
};

module.exports = {
    VmCompileError,
    createContext,
    allocRegister,
    addConstant,
    emit
};
