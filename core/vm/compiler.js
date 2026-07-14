const { VmCompileError, createContext, allocRegister, addConstant, emit } = require('./ir');
const { assertSupported } = require('./compatibility');

const BINARY_OPS = {
    '+': 'ADD',
    '-': 'SUB',
    '*': 'MUL',
    '/': 'DIV',
    '..': 'CONCAT'
};

const COMPARISON_OPS = {
    '==': ['EQ', false, false],
    '~=': ['EQ', false, true],
    '<': ['LT', false, false],
    '>': ['LT', true, false],
    '<=': ['LE', false, false],
    '>=': ['LE', true, false]
};

const patchJump = (ctx, instructionIndex, target = ctx.instructions.length + 1) => {
    ctx.instructions[instructionIndex - 1].a = target;
};

const patchTarget = (ctx, instructionIndex, field, target = ctx.instructions.length + 1) => {
    ctx.instructions[instructionIndex - 1][field] = target;
};

const withBindingScope = (ctx, callback) => {
    const bindings = ctx.bindings;
    ctx.bindings = new Map(bindings);
    try { return callback(); } finally { ctx.bindings = bindings; }
};

const reserveRegisters = (ctx, count) => {
    const start = ctx.registers + 1;
    ctx.registers += Math.max(1, count);
    return start;
};

const literalValue = (node) => {
    if (node.type === 'NumericLiteral') return Number(node.value);
    if (node.type === 'StringLiteral') {
        return node.value !== null && node.value !== undefined
            ? String(node.value)
            : String(node.raw || '').slice(1, -1);
    }
    throw new VmCompileError(`unsupported literal: ${node.type}`);
};

const moveToContiguous = (ctx, registers) => {
    const start = reserveRegisters(ctx, registers.length);
    registers.forEach((reg, index) => emit(ctx, 'MOVE', start + index, reg));
    return start;
};

const compileExpression = (ctx, node, wantedResults = 1) => {
    if (!node) throw new VmCompileError('missing expression');

    if (['NumericLiteral', 'StringLiteral'].includes(node.type)) {
        const reg = allocRegister(ctx);
        emit(ctx, 'LOAD_CONST', reg, addConstant(ctx, literalValue(node)));
        return reg;
    }
    if (node.type === 'NilLiteral') {
        const reg = allocRegister(ctx);
        emit(ctx, 'LOAD_NIL', reg);
        return reg;
    }
    if (node.type === 'BooleanLiteral') {
        const reg = allocRegister(ctx);
        emit(ctx, 'LOAD_BOOL', reg, node.value ? 1 : 0);
        return reg;
    }
    if (node.type === 'VarargLiteral') {
        if (!ctx.hasVararg) throw new VmCompileError('vararg used outside a vararg function');
        const reg = reserveRegisters(ctx, wantedResults || 1);
        emit(ctx, 'VARARG', reg, wantedResults);
        return reg;
    }
    if (node.type === 'Identifier') {
        if (ctx.bindings.has(node.name)) return ctx.bindings.get(node.name);
        const reg = allocRegister(ctx);
        if (ctx.upvalueMap.has(node.name)) {
            emit(ctx, 'GET_UPVALUE', reg, ctx.upvalueMap.get(node.name));
            return reg;
        }
        emit(ctx, 'GET_GLOBAL', reg, addConstant(ctx, node.name));
        return reg;
    }
    if (node.type === 'FunctionDeclaration') {
        const prototype = compileFunctionToIr(node, {
            maxNodes: ctx.maxNodes,
            upvalues: node._vmUpvalues || []
        });
        ctx.prototypes.push(prototype);
        const captures = prototype.upvalues.map(upvalue => {
            if (ctx.bindings.has(upvalue)) {
                const index = ctx.bindings.get(upvalue);
                return { kind: ctx.loopCaptureRegisters.has(index) ? 'loop-register' : 'register', index };
            }
            if (ctx.upvalueMap.has(upvalue)) return { kind: 'upvalue', index: ctx.upvalueMap.get(upvalue) };
            throw new VmCompileError(`unresolved nested upvalue: ${upvalue}`);
        });
        ctx.closureSpecs.push({ prototype: ctx.prototypes.length, captures });
        const reg = allocRegister(ctx);
        emit(ctx, 'CLOSURE', reg, ctx.closureSpecs.length);
        return reg;
    }
    if (node.type === 'TableConstructorExpression') {
        const tableReg = allocRegister(ctx);
        emit(ctx, 'NEW_TABLE', tableReg);
        let arrayIndex = 1;
        const fields = node.fields || [];
        for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
            const field = fields[fieldIndex];
            if (field.type === 'TableValue' && fieldIndex === fields.length - 1
                && ['CallExpression', 'VarargLiteral'].includes(field.value.type)) {
                const valueReg = compileExpression(ctx, field.value, 0);
                emit(ctx, 'SET_LIST', tableReg, valueReg, arrayIndex, 0);
                continue;
            }
            let keyNode;
            if (field.type === 'TableValue') {
                keyNode = { type: 'NumericLiteral', value: arrayIndex++ };
            } else if (field.type === 'TableKeyString') {
                keyNode = { type: 'StringLiteral', value: field.key.name };
            } else if (field.type === 'TableKey') {
                keyNode = field.key;
            } else {
                throw new VmCompileError(`unsupported table field: ${field.type}`);
            }
            const keyReg = compileExpression(ctx, keyNode);
            const valueReg = compileExpression(ctx, field.value);
            emit(ctx, 'SET_TABLE', tableReg, keyReg, valueReg);
        }
        return tableReg;
    }
    if (node.type === 'IndexExpression' || (node.type === 'MemberExpression' && node.indexer === '.')) {
        const baseReg = compileExpression(ctx, node.base);
        const keyNode = node.type === 'IndexExpression'
            ? node.index
            : { type: 'StringLiteral', value: node.identifier.name };
        const keyReg = compileExpression(ctx, keyNode);
        const result = allocRegister(ctx);
        emit(ctx, 'GET_TABLE', result, baseReg, keyReg);
        return result;
    }
    if (node.type === 'BinaryExpression' && BINARY_OPS[node.operator]) {
        const left = compileExpression(ctx, node.left);
        const right = compileExpression(ctx, node.right);
        const reg = allocRegister(ctx);
        emit(ctx, BINARY_OPS[node.operator], reg, left, right);
        return reg;
    }
    if (node.type === 'BinaryExpression' && COMPARISON_OPS[node.operator]) {
        let left = compileExpression(ctx, node.left);
        let right = compileExpression(ctx, node.right);
        const [op, swap, negate] = COMPARISON_OPS[node.operator];
        if (swap) [left, right] = [right, left];
        const reg = allocRegister(ctx);
        emit(ctx, op, reg, left, right);
        if (negate) emit(ctx, 'NOT', reg, reg);
        return reg;
    }
    if (node.type === 'UnaryExpression') {
        const source = compileExpression(ctx, node.argument);
        const reg = allocRegister(ctx);
        const op = { not: 'NOT', '#': 'LEN', '-': 'UNM' }[node.operator];
        if (!op) throw new VmCompileError(`unsupported unary operator: ${node.operator}`);
        emit(ctx, op, reg, source);
        return reg;
    }
    if (node.type === 'LogicalExpression') {
        const result = allocRegister(ctx);
        const left = compileExpression(ctx, node.left);
        emit(ctx, 'MOVE', result, left);
        const jump = emit(ctx, 'JUMP_IF', 0, result, node.operator === 'or' ? 1 : 0);
        const right = compileExpression(ctx, node.right);
        emit(ctx, 'MOVE', result, right);
        patchJump(ctx, jump);
        return result;
    }
    if (node.type === 'CallExpression') {
        let functionReg;
        const implicitArgs = [];
        if (node.base && node.base.type === 'MemberExpression' && node.base.indexer === ':') {
            const receiverReg = compileExpression(ctx, node.base.base);
            const keyReg = compileExpression(ctx, { type: 'StringLiteral', value: node.base.identifier.name });
            functionReg = reserveRegisters(ctx, 2);
            emit(ctx, 'SELF', functionReg, receiverReg, keyReg);
            implicitArgs.push(functionReg + 1);
        } else {
            const callee = compileExpression(ctx, node.base);
            functionReg = allocRegister(ctx);
            emit(ctx, 'MOVE', functionReg, callee);
        }

        const callArgs = node.arguments || [];
        const dynamicArgs = callArgs.length > 0
            && ['VarargLiteral', 'CallExpression'].includes(callArgs[callArgs.length - 1].type);
        const explicitArgs = callArgs
            .slice(0, dynamicArgs ? -1 : undefined)
            .map(arg => compileExpression(ctx, arg));
        let argStart = 0;
        let argCount = 0;
        const fixedArgs = [...implicitArgs, ...explicitArgs];
        if (dynamicArgs) {
            argStart = reserveRegisters(ctx, Math.max(1, fixedArgs.length + 1));
            fixedArgs.forEach((reg, index) => emit(ctx, 'MOVE', argStart + index, reg));
            const dynamicNode = callArgs[callArgs.length - 1];
            if (dynamicNode.type === 'VarargLiteral') emit(ctx, 'VARARG', argStart + fixedArgs.length, 0);
            else emit(ctx, 'MULTI_MOVE', argStart + fixedArgs.length, compileExpression(ctx, dynamicNode, 0), 0);
            argCount = -(fixedArgs.length + 1);
        } else if (fixedArgs.length) {
            argStart = moveToContiguous(ctx, fixedArgs);
            argCount = fixedArgs.length;
        }
        if (wantedResults > 1) {
            const resultBase = reserveRegisters(ctx, wantedResults);
            emit(ctx, 'MOVE', resultBase, functionReg);
            functionReg = resultBase;
        }
        emit(ctx, 'CALL', functionReg, argStart, argCount, wantedResults);
        return functionReg;
    }
    throw new VmCompileError(`unsupported expression: ${node.type}`);
};

const bindLocalResults = (ctx, variables, startReg) => {
    const targetStart = reserveRegisters(ctx, variables.length);
    if (ctx.loopScopeDepth > 0) {
        for (let index = 0; index < variables.length; index++) {
            emit(ctx, 'RESET_CELL', targetStart + index);
        }
    }
    emit(ctx, 'MULTI_MOVE', targetStart, startReg, variables.length);
    variables.forEach((variable, index) => {
        if (!variable || variable.type !== 'Identifier') throw new VmCompileError('unsupported local variable');
        ctx.bindings.set(variable.name, targetStart + index);
    });
};

const compileExpressionList = (ctx, values, wantedCount) => {
    const registers = [];
    const list = values || [];
    for (let index = 0; index < list.length; index++) {
        const value = list[index];
        const remaining = Math.max(1, wantedCount - registers.length);
        const expands = index === list.length - 1 && ['CallExpression', 'VarargLiteral'].includes(value.type);
        const start = compileExpression(ctx, value, expands ? remaining : 1);
        const count = expands ? remaining : 1;
        for (let offset = 0; offset < count; offset++) registers.push(start + offset);
    }
    while (registers.length < wantedCount) registers.push(compileExpression(ctx, { type: 'NilLiteral' }));
    return moveToContiguous(ctx, registers.slice(0, wantedCount));
};

const compileLocalStatement = (ctx, statement) => {
    const vars = statement.variables || [];
    const inits = statement.init || [];
    bindLocalResults(ctx, vars, compileExpressionList(ctx, inits, vars.length));
};

const compileAssignment = (ctx, statement) => {
    const vars = statement.variables || [];
    const values = statement.init || [];
    const valueBase = compileExpressionList(ctx, values, vars.length);
    vars.forEach((variable, index) => {
        const valueReg = valueBase + index;
        if (variable.type === 'Identifier') {
            if (ctx.bindings.has(variable.name)) emit(ctx, 'MOVE', ctx.bindings.get(variable.name), valueReg);
            else if (ctx.upvalueMap.has(variable.name)) emit(ctx, 'SET_UPVALUE', valueReg, ctx.upvalueMap.get(variable.name));
            else emit(ctx, 'SET_GLOBAL', valueReg, addConstant(ctx, variable.name));
            return;
        }
        if (variable.type === 'IndexExpression' || (variable.type === 'MemberExpression' && variable.indexer === '.')) {
            const tableReg = compileExpression(ctx, variable.base);
            const keyNode = variable.type === 'IndexExpression'
                ? variable.index
                : { type: 'StringLiteral', value: variable.identifier.name };
            const keyReg = compileExpression(ctx, keyNode);
            emit(ctx, 'SET_TABLE', tableReg, keyReg, valueReg);
            return;
        }
        throw new VmCompileError(`unsupported assignment target: ${variable.type}`);
    });
};

const compileStatements = (ctx, statements) => {
    for (const statement of statements || []) {
        if (statement.type === 'LocalStatement') compileLocalStatement(ctx, statement);
        else if (statement.type === 'AssignmentStatement') compileAssignment(ctx, statement);
        else if (statement.type === 'ReturnStatement') compileReturn(ctx, statement);
        else if (statement.type === 'CallStatement') compileExpression(ctx, statement.expression, 1);
        else if (statement.type === 'IfStatement') compileIf(ctx, statement);
        else if (statement.type === 'WhileStatement') compileWhile(ctx, statement);
        else if (statement.type === 'RepeatStatement') compileRepeat(ctx, statement);
        else if (statement.type === 'ForNumericStatement') compileNumericFor(ctx, statement);
        else if (statement.type === 'ForGenericStatement') compileGenericFor(ctx, statement);
        else if (statement.type === 'BreakStatement') {
            const loop = ctx.loopStack[ctx.loopStack.length - 1];
            if (!loop) throw new VmCompileError('break outside loop');
            loop.breakJumps.push(emit(ctx, 'JUMP', 0));
        }
        else if (statement.type === 'FunctionDeclaration') {
            if (statement.isLocal && statement.identifier?.type === 'Identifier') {
                const target = allocRegister(ctx);
                ctx.bindings.set(statement.identifier.name, target);
                if (ctx.loopScopeDepth > 0) emit(ctx, 'RESET_CELL', target);
                emit(ctx, 'MOVE', target, compileExpression(ctx, statement));
            } else if (statement.identifier?.type === 'Identifier') {
                emit(ctx, 'SET_GLOBAL', compileExpression(ctx, statement), addConstant(ctx, statement.identifier.name));
            } else if (statement.identifier?.type === 'MemberExpression') {
                const tableReg = compileExpression(ctx, statement.identifier.base);
                const keyReg = compileExpression(ctx, {
                    type: 'StringLiteral',
                    value: statement.identifier.identifier.name
                });
                emit(ctx, 'SET_TABLE', tableReg, keyReg, compileExpression(ctx, statement));
            } else {
                throw new VmCompileError('unsupported nested function declaration target');
            }
        }
        else throw new VmCompileError(`unsupported statement: ${statement.type}`);
    }
};

const compileIf = (ctx, statement) => {
    const endJumps = [];
    for (const clause of statement.clauses || []) {
        let falseJump = null;
        if (clause.condition) {
            const condition = compileExpression(ctx, clause.condition);
            falseJump = emit(ctx, 'JUMP_IF', 0, condition, 0);
        }
        withBindingScope(ctx, () => compileStatements(ctx, clause.body));
        if (clause.condition) endJumps.push(emit(ctx, 'JUMP', 0));
        if (falseJump) patchJump(ctx, falseJump);
    }
    for (const jump of endJumps) patchJump(ctx, jump);
};

const compileWhile = (ctx, statement) => {
    const conditionTarget = ctx.instructions.length + 1;
    const condition = compileExpression(ctx, statement.condition);
    const exitJump = emit(ctx, 'JUMP_IF', 0, condition, 0);
    const loop = { breakJumps: [] };
    ctx.loopStack.push(loop);
    withBindingScope(ctx, () => compileStatements(ctx, statement.body));
    ctx.loopStack.pop();
    emit(ctx, 'JUMP', conditionTarget);
    const exitTarget = ctx.instructions.length + 1;
    patchJump(ctx, exitJump, exitTarget);
    loop.breakJumps.forEach(jump => patchJump(ctx, jump, exitTarget));
};

const compileRepeat = (ctx, statement) => {
    const bodyTarget = ctx.instructions.length + 1;
    const loop = { breakJumps: [] };
    ctx.loopStack.push(loop);
    const outerBindings = ctx.bindings;
    ctx.bindings = new Map(outerBindings);
    compileStatements(ctx, statement.body);
    ctx.loopStack.pop();
    const condition = compileExpression(ctx, statement.condition);
    ctx.bindings = outerBindings;
    emit(ctx, 'JUMP_IF', bodyTarget, condition, 0);
    const exitTarget = ctx.instructions.length + 1;
    loop.breakJumps.forEach(jump => patchJump(ctx, jump, exitTarget));
};

const compileNumericFor = (ctx, statement) => {
    const startReg = compileExpression(ctx, statement.start);
    const limitReg = compileExpression(ctx, statement.end);
    const stepReg = compileExpression(ctx, statement.step || { type: 'NumericLiteral', value: 1 });
    const indexReg = allocRegister(ctx);
    emit(ctx, 'MOVE', indexReg, startReg);
    const prep = emit(ctx, 'FOR_PREP', indexReg, limitReg, stepReg, 0);
    const bodyTarget = ctx.instructions.length + 1;
    const loop = { breakJumps: [] };
    ctx.loopStack.push(loop);
    withBindingScope(ctx, () => {
        ctx.bindings.set(statement.variable.name, indexReg);
        ctx.loopScopeDepth += 1;
        try { compileStatements(ctx, statement.body); } finally { ctx.loopScopeDepth -= 1; }
    });
    ctx.loopStack.pop();
    emit(ctx, 'RESET_CELL', indexReg);
    emit(ctx, 'FOR_LOOP', indexReg, limitReg, stepReg, bodyTarget);
    const exitTarget = ctx.instructions.length + 1;
    patchTarget(ctx, prep, 'd', exitTarget);
    loop.breakJumps.forEach(jump => patchJump(ctx, jump, exitTarget));
};

const compileGenericFor = (ctx, statement) => {
    const iterators = statement.iterators || [];
    let iteratorBase;
    if (iterators.length === 1 && ['CallExpression', 'VarargLiteral'].includes(iterators[0].type)) {
        iteratorBase = compileExpression(ctx, iterators[0], 3);
    } else {
        const registers = iterators.slice(0, 3).map(iterator => compileExpression(ctx, iterator));
        while (registers.length < 3) registers.push(compileExpression(ctx, { type: 'NilLiteral' }));
        iteratorBase = moveToContiguous(ctx, registers);
    }
    emit(ctx, 'ITER_PREP', iteratorBase);
    const variableBase = reserveRegisters(ctx, Math.max(1, (statement.variables || []).length));
    const nextJump = emit(ctx, 'JUMP', 0);
    const bodyTarget = ctx.instructions.length + 1;
    const loop = { breakJumps: [] };
    ctx.loopStack.push(loop);
    withBindingScope(ctx, () => {
        (statement.variables || []).forEach((variable, index) => {
            ctx.bindings.set(variable.name, variableBase + index);
        });
        ctx.loopScopeDepth += 1;
        try { compileStatements(ctx, statement.body); } finally { ctx.loopScopeDepth -= 1; }
    });
    ctx.loopStack.pop();
    const nextTarget = ctx.instructions.length + 1;
    patchJump(ctx, nextJump, nextTarget);
    for (let index = 0; index < (statement.variables || []).length; index++) {
        emit(ctx, 'RESET_CELL', variableBase + index);
    }
    emit(ctx, 'ITER_NEXT', iteratorBase, variableBase, (statement.variables || []).length, bodyTarget);
    const exitTarget = ctx.instructions.length + 1;
    loop.breakJumps.forEach(jump => patchJump(ctx, jump, exitTarget));
};

const compileReturn = (ctx, statement) => {
    const values = statement.arguments || [];
    if (values.length === 0) {
        emit(ctx, 'RETURN', 0, 0);
        return;
    }
    if (values.length === 1 && ['CallExpression', 'VarargLiteral'].includes(values[0].type)) {
        emit(ctx, 'RETURN', compileExpression(ctx, values[0], 0), 0);
        return;
    }
    const last = values[values.length - 1];
    if (last && ['CallExpression', 'VarargLiteral'].includes(last.type)) {
        const fixed = values.slice(0, -1).map(value => compileExpression(ctx, value));
        const start = reserveRegisters(ctx, fixed.length + 1);
        fixed.forEach((reg, index) => emit(ctx, 'MOVE', start + index, reg));
        emit(ctx, 'MULTI_MOVE', start + fixed.length, compileExpression(ctx, last, 0), 0);
        emit(ctx, 'RETURN', start, -(fixed.length + 1));
        return;
    }
    const registers = values.map(value => compileExpression(ctx, value));
    emit(ctx, 'RETURN', moveToContiguous(ctx, registers), registers.length);
};

const compileFunctionToIr = (fnNode, options = {}) => {
    assertSupported(fnNode, { maxNodes: options.maxNodes, allowAnonymous: !fnNode.identifier });
    const parameters = fnNode.parameters || [];
    const namedParams = parameters.filter(param => param.type === 'Identifier').map(param => param.name);
    if (fnNode.identifier?.type === 'MemberExpression' && fnNode.identifier.indexer === ':') {
        namedParams.unshift('self');
    }
    const ctx = createContext(namedParams);
    ctx.maxNodes = options.maxNodes;
    ctx.upvalues = [...(options.upvalues || fnNode._vmUpvalues || [])];
    ctx.upvalueMap = new Map(ctx.upvalues.map((upvalue, index) => [upvalue, index + 1]));
    ctx.hasVararg = parameters.some(param => param.type === 'VarargLiteral');
    ctx.loopStack = [];
    ctx.loopCaptureRegisters = new Set();
    ctx.loopScopeDepth = 0;
    ctx.registers = namedParams.length;
    namedParams.forEach((param, index) => {
        const targetReg = allocRegister(ctx);
        emit(ctx, 'MOVE', targetReg, index + 1);
        ctx.bindings.set(param, targetReg);
    });

    compileStatements(ctx, fnNode.body);
    if (ctx.instructions[ctx.instructions.length - 1]?.op !== 'RETURN') emit(ctx, 'RETURN', 0, 0);
    return {
        name: fnNode._vmName || fnNode.identifier?.name || null,
        params: ctx.params,
        hasVararg: ctx.hasVararg,
        upvalues: ctx.upvalues,
        selfName: fnNode.identifier?.name || null,
        constants: ctx.constants,
        instructions: ctx.instructions,
        prototypes: ctx.prototypes,
        closureSpecs: ctx.closureSpecs,
        registerCount: ctx.registers
    };
};

module.exports = { compileFunctionToIr };
