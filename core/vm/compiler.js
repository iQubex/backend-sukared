const { VmCompileError, createContext, allocRegister, addConstant, emit } = require('./ir');
const { assertSupported } = require('./compatibility');

const BINARY_OPS = {
    '+': 'ADD',
    '-': 'SUB',
    '*': 'MUL',
    '/': 'DIV'
};

const literalValue = (node) => {
    if (node.type === 'NumericLiteral') return Number(node.value);
    if (node.type === 'StringLiteral') return node.value !== null && node.value !== undefined ? String(node.value) : String(node.raw || '').slice(1, -1);
    if (node.type === 'BooleanLiteral') return Boolean(node.value);
    throw new VmCompileError(`unsupported literal: ${node.type}`);
};

const compileExpression = (ctx, node) => {
    if (!node) throw new VmCompileError('missing expression');

    if (['NumericLiteral', 'StringLiteral', 'BooleanLiteral'].includes(node.type)) {
        const reg = allocRegister(ctx);
        emit(ctx, 'LOAD_CONST', reg, addConstant(ctx, literalValue(node)), 0);
        return reg;
    }

    if (node.type === 'Identifier') {
        if (ctx.bindings.has(node.name)) return ctx.bindings.get(node.name);
        const reg = allocRegister(ctx);
        emit(ctx, 'GET_GLOBAL', reg, addConstant(ctx, node.name), 0);
        return reg;
    }

    if (node.type === 'BinaryExpression' && BINARY_OPS[node.operator]) {
        const left = compileExpression(ctx, node.left);
        const right = compileExpression(ctx, node.right);
        const reg = allocRegister(ctx);
        emit(ctx, BINARY_OPS[node.operator], reg, left, right);
        return reg;
    }

    if (node.type === 'CallExpression') {
        const base = compileExpression(ctx, node.base);
        const args = node.arguments || [];
        const argStart = ctx.registers + 1;
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            const argReg = compileExpression(ctx, arg);
            const expected = argStart + i;
            if (argReg !== expected) emit(ctx, 'MOVE', expected, argReg, 0);
            if (ctx.registers < expected) ctx.registers = expected;
        }
        emit(ctx, 'CALL', base, argStart, args.length);
        return base;
    }

    throw new VmCompileError(`unsupported expression: ${node.type}`);
};

const compileLocalStatement = (ctx, statement) => {
    const vars = statement.variables || [];
    const inits = statement.init || [];
    for (let i = 0; i < vars.length; i++) {
        const variable = vars[i];
        if (!variable || variable.type !== 'Identifier') throw new VmCompileError('unsupported local variable');
        if (!inits[i]) throw new VmCompileError('local without initializer is not supported in VM Phase 1');
        const valueReg = compileExpression(ctx, inits[i]);
        const target = allocRegister(ctx);
        emit(ctx, 'MOVE', target, valueReg, 0);
        ctx.bindings.set(variable.name, target);
    }
};

const compileFunctionToIr = (fnNode, options = {}) => {
    assertSupported(fnNode, { maxNodes: options.maxNodes });
    const ctx = createContext((fnNode.parameters || []).map(param => param.name));

    ctx.registers = ctx.params.length;
    for (let i = 0; i < ctx.params.length; i++) {
        const param = ctx.params[i];
        const sourceReg = i + 1;
        const targetReg = allocRegister(ctx);
        emit(ctx, 'MOVE', targetReg, sourceReg, 0);
        ctx.bindings.set(param, targetReg);
    }

    for (const statement of fnNode.body || []) {
        if (statement.type === 'LocalStatement') {
            compileLocalStatement(ctx, statement);
            continue;
        }
        if (statement.type === 'ReturnStatement') {
            const args = statement.arguments || [];
            if (args.length !== 1) throw new VmCompileError('VM Phase 1 supports exactly one return value');
            const reg = compileExpression(ctx, args[0]);
            emit(ctx, 'RETURN', reg, 1, 0);
            continue;
        }
        throw new VmCompileError(`unsupported statement: ${statement.type}`);
    }

    if (!ctx.instructions.some(inst => inst.op === 'RETURN')) {
        throw new VmCompileError('function has no supported return');
    }

    return {
        params: ctx.params,
        constants: ctx.constants,
        instructions: ctx.instructions,
        registerCount: ctx.registers
    };
};

module.exports = {
    compileFunctionToIr
};
