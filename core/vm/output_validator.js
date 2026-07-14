const { parse } = require('../ast_traverser');

const walk = (node, visit) => {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(item => walk(item, visit));
        else if (value && typeof value === 'object' && value.type) walk(value, visit);
    }
};

const tableFieldCount = (node) => {
    if (!node || node.type !== 'TableConstructorExpression') return 0;
    let count = (node.fields || []).length;
    for (const field of node.fields || []) {
        if (field.value && field.value.type === 'TableConstructorExpression') {
            count += tableFieldCount(field.value);
        }
    }
    return count;
};

const inspectFunction = (node) => {
    const body = node.body || [];
    const tables = [];
    walk(node, child => {
        if (child.type === 'TableConstructorExpression') tables.push(child);
    });
    const hasBytecode = tables.some(table => tableFieldCount(table) >= 15);
    const hasRegisters = tables.some(table => (table.fields || []).length === 0);
    let handlerAssignments = 0;
    let stateDispatches = 0;
    let conditionalBranches = 0;
    walk(node, child => {
        if (child.type === 'AssignmentStatement'
            && child.variables?.[0]?.type === 'IndexExpression'
            && child.init?.[0]?.type === 'FunctionDeclaration') handlerAssignments += 1;
        if (child.type === 'RepeatStatement') stateDispatches += 1;
        if (child.type === 'IfStatement') conditionalBranches += (child.clauses || []).length;
    });

    const loops = [];
    walk(node, child => {
        if (child.type === 'WhileStatement') loops.push(child);
    });
    for (const statement of loops) {
        if (statement.type !== 'WhileStatement'
            || statement.condition?.type !== 'BooleanLiteral'
            || statement.condition.value !== true) continue;
        const loopBody = statement.body || [];
        const fetchLocals = loopBody.filter(item => item.type === 'LocalStatement').length;
        const dispatch = loopBody.find(item => item.type === 'IfStatement');
        const dispatchBranches = Math.max(
            dispatch ? (dispatch.clauses || []).length : 0,
            handlerAssignments,
            stateDispatches,
            conditionalBranches
        );
        const hasInstructionPointer = body.some(item => item.type === 'LocalStatement')
            || fetchLocals > 0;
        const hasOpcodeDispatch = handlerAssignments > 0 || stateDispatches > 0 || conditionalBranches > 0;
        if (hasRegisters && hasBytecode && hasInstructionPointer && fetchLocals >= 5 && hasOpcodeDispatch) {
            return {
                valid: true,
                hasRegisters,
                hasInstructionPointer,
                hasBytecode,
                hasInterpreterLoop: true,
                hasOpcodeDispatch,
                dispatchBranches
            };
        }
    }
    return null;
};

const validateVmOutput = (source) => {
    const ast = parse(source, 'vm-output-validation');
    const functions = [];
    walk(ast, node => {
        if (node.type === 'FunctionDeclaration') functions.push(node);
    });
    for (const fn of functions) {
        const result = inspectFunction(fn);
        if (result) return result;
    }
    return {
        valid: false,
        hasRegisters: false,
        hasInstructionPointer: false,
        hasBytecode: false,
        hasInterpreterLoop: false,
        hasOpcodeDispatch: false,
        dispatchBranches: 0
    };
};

module.exports = { validateVmOutput };
