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

const isSupportedParamList = (params = []) => params.every((param, index) => param
    && (param.type === 'Identifier' || (param.type === 'VarargLiteral' && index === params.length - 1)));

const isSupportedFunctionIdentifier = (node) => !node
    || node.type === 'Identifier'
    || (node.type === 'MemberExpression'
        && ['.', ':'].includes(node.indexer)
        && node.identifier?.type === 'Identifier');

const expressionReason = (node, context = {}) => {
    if (!node) return 'missing expression';
    if (['NumericLiteral', 'StringLiteral', 'BooleanLiteral', 'NilLiteral', 'Identifier'].includes(node.type)) return null;
    if (node.type === 'VarargLiteral') return context.hasVararg ? null : 'vararg outside vararg function';
    if (node.type === 'FunctionDeclaration') {
        return unsupportedReason(node, {
            maxNodes: context.maxNodes,
            allowAnonymous: !node.identifier
        });
    }
    if (node.type === 'BinaryExpression') {
        if (!['+', '-', '*', '/', '..', '==', '~=', '<', '>', '<=', '>='].includes(node.operator)) return `unsupported binary operator: ${node.operator}`;
        return expressionReason(node.left, context) || expressionReason(node.right, context);
    }
    if (node.type === 'LogicalExpression') {
        if (!['and', 'or'].includes(node.operator)) return `unsupported logical operator: ${node.operator}`;
        return expressionReason(node.left, context) || expressionReason(node.right, context);
    }
    if (node.type === 'UnaryExpression') {
        if (!['not', '#', '-'].includes(node.operator)) return `unsupported unary operator: ${node.operator}`;
        return expressionReason(node.argument, context);
    }
    if (node.type === 'IndexExpression') {
        return expressionReason(node.base, context) || expressionReason(node.index, context);
    }
    if (node.type === 'MemberExpression' && node.indexer === '.') return expressionReason(node.base, context);
    if (node.type === 'TableConstructorExpression') {
        for (const field of node.fields || []) {
            if (!['TableValue', 'TableKeyString', 'TableKey'].includes(field.type)) return `unsupported table field: ${field.type}`;
            if (field.type === 'TableKey') {
                const keyReason = expressionReason(field.key, context);
                if (keyReason) return keyReason;
            }
            const valueReason = expressionReason(field.value, context);
            if (valueReason) return valueReason;
        }
        return null;
    }
    if (node.type === 'CallExpression') {
        const base = node.base;
        const baseReason = base && base.type === 'MemberExpression' && base.indexer === ':'
            ? expressionReason(base.base, context)
            : expressionReason(base, context);
        if (baseReason) return baseReason;
        for (const argument of node.arguments || []) {
            const reason = expressionReason(argument, context);
            if (reason) return reason;
        }
        return null;
    }
    return `unsupported expression: ${node.type}`;
};

const targetReason = (node, context) => {
    if (!node) return 'missing assignment target';
    if (node.type === 'Identifier') return null;
    if (node.type === 'IndexExpression') return expressionReason(node.base, context) || expressionReason(node.index, context);
    if (node.type === 'MemberExpression' && node.indexer === '.') return expressionReason(node.base, context);
    return `unsupported assignment target: ${node.type}`;
};

const statementsReason = (statements, context, limits, loopDepth = 0) => {
    for (const statement of statements || []) {
        if (statement.type === 'BreakStatement') {
            if (!loopDepth) return 'break outside loop';
            continue;
        }
        if (statement.type === 'FunctionDeclaration') {
            const reason = unsupportedReason(statement, { maxNodes: limits.maxNodes, allowAnonymous: !statement.identifier });
            if (reason) return reason;
            continue;
        }
        if (statement.type === 'IfStatement') {
            for (const clause of statement.clauses || []) {
                if (clause.condition) {
                    const reason = expressionReason(clause.condition, context);
                    if (reason) return reason;
                }
                const reason = statementsReason(clause.body, context, limits, loopDepth);
                if (reason) return reason;
            }
            continue;
        }
        if (statement.type === 'WhileStatement' || statement.type === 'RepeatStatement') {
            const reason = expressionReason(statement.condition, context)
                || statementsReason(statement.body, context, limits, loopDepth + 1);
            if (reason) return reason;
            continue;
        }
        if (statement.type === 'ForNumericStatement') {
            if (statement.variable?.type !== 'Identifier') return 'unsupported numeric for variable';
            const reason = expressionReason(statement.start, context)
                || expressionReason(statement.end, context)
                || (statement.step && expressionReason(statement.step, context))
                || statementsReason(statement.body, context, limits, loopDepth + 1);
            if (reason) return reason;
            continue;
        }
        if (statement.type === 'ForGenericStatement') {
            if ((statement.variables || []).some(variable => variable.type !== 'Identifier')) return 'unsupported generic for variable';
            for (const iterator of statement.iterators || []) {
                const reason = expressionReason(iterator, context);
                if (reason) return reason;
            }
            const reason = statementsReason(statement.body, context, limits, loopDepth + 1);
            if (reason) return reason;
            continue;
        }
        if (statement.type === 'LocalStatement') {
            if ((statement.variables || []).some(variable => variable.type !== 'Identifier')) return 'unsupported local variable';
            for (const init of statement.init || []) {
                const reason = expressionReason(init, context);
                if (reason) return reason;
            }
            continue;
        }
        if (statement.type === 'AssignmentStatement') {
            for (const variable of statement.variables || []) {
                const reason = targetReason(variable, context);
                if (reason) return reason;
            }
            for (const value of statement.init || []) {
                const reason = expressionReason(value, context);
                if (reason) return reason;
            }
            continue;
        }
        if (statement.type === 'ReturnStatement') {
            for (const value of statement.arguments || []) {
                const reason = expressionReason(value, context);
                if (reason) return reason;
            }
            continue;
        }
        if (statement.type === 'CallStatement') {
            const reason = expressionReason(statement.expression, context);
            if (reason) return reason;
            continue;
        }
        return `unsupported statement: ${statement.type}`;
    }
    return null;
};

const unsupportedReason = (fnNode, limits = {}) => {
    if (!fnNode || fnNode.type !== 'FunctionDeclaration') return 'unsupported node';
    const namedLocal = fnNode.isLocal && fnNode.identifier?.type === 'Identifier';
    const anonymous = !fnNode.identifier && limits.allowAnonymous === true;
    const nonLocal = !fnNode.isLocal && isSupportedFunctionIdentifier(fnNode.identifier);
    if (!namedLocal && !anonymous && !nonLocal) return 'unsupported function declaration target';
    if (!isSupportedParamList(fnNode.parameters || [])) return 'unsupported parameters';
    const nodeCount = countNodes(fnNode);
    if (nodeCount > (limits.maxNodes || 90)) return 'function too large';
    const context = {
        hasVararg: (fnNode.parameters || []).some(param => param.type === 'VarargLiteral'),
        maxNodes: limits.maxNodes
    };
    return statementsReason(fnNode.body, context, limits);
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
