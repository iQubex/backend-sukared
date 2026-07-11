const luaparse = require('luaparse');
const cipher = require('../utils/braille_cipher');
const { parseLuaString } = require('./preprocessor');

const YIELD_EVERY_NODES = 1500;
const runtimeNames = new Set(['getfenv', 'lIIll_10O_l', 'lO_10O_lI']);

class Scope {
    constructor(parent = null) {
        this.parent = parent;
        this.bindings = Object.create(null);
    }

    define(name, newName) {
        this.bindings[name] = newName;
    }

    lookup(name) {
        let scope = this;
        while (scope) {
            if (Object.prototype.hasOwnProperty.call(scope.bindings, name)) return scope.bindings[name];
            scope = scope.parent;
        }
        return null;
    }
}

const randomName = () => {
    const chars = ['l', 'I', 'O', '_', '0', '1'];
    let value = '_';
    for (let i = 0; i < 16; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
};

const createRootScope = () => {
    const scope = new Scope();
    for (const name of runtimeNames) scope.define(name, name);
    return scope;
};

const parse = (code) => luaparse.parse(code, {
    comments: false,
    scope: false,
    luaVersion: '5.2'
});

const pushArray = (stack, items, scope) => {
    if (!items) return;
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]) stack.push({ node: items[i], scope });
    }
};

const replaceNode = (target, source) => {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
};

const encryptStringNode = (node, state) => {
    const value = node.value !== undefined && node.value !== null ? String(node.value) : parseLuaString(node.raw);
    if (value.length === 0) return;
    replaceNode(node, cipher.createDecoderCall(value));
    state.hasEncryptedStrings = true;
};

const transformIdentifier = (node, scope, state) => {
    const resolved = scope.lookup(node.name);
    if (resolved !== null) {
        node.name = resolved;
        return;
    }
    if (runtimeNames.has(node.name)) return;
    replaceNode(node, cipher.createGetfenvLookup(node.name));
    state.hasEncryptedStrings = true;
};

const transformMemberExpression = (node, state) => {
    if (!node.identifier || !node.identifier.name) return;
    node.type = 'IndexExpression';
    node.index = cipher.createDecoderCall(node.identifier.name);
    delete node.identifier;
    delete node.indexer;
    state.hasEncryptedStrings = true;
};

const transformColonCall = (node, state) => {
    const base = node.base;
    if (!base || base.type !== 'MemberExpression' || base.indexer !== ':' || !base.identifier) return false;
    const methodObject = base.base;
    const selfArgument = JSON.parse(JSON.stringify(methodObject));
    node.arguments = [selfArgument, ...(node.arguments || [])];
    node.base = {
        type: 'IndexExpression',
        base: methodObject,
        index: cipher.createDecoderCall(base.identifier.name)
    };
    state.hasEncryptedStrings = true;
    return true;
};

const walkAst = async (root, state) => {
    const stack = [{ node: root, scope: createRootScope() }];
    let processed = 0;

    while (stack.length) {
        const { node, scope } = stack.pop();
        if (!node) continue;
        if (++processed % YIELD_EVERY_NODES === 0) await new Promise(resolve => setImmediate(resolve));

        switch (node.type) {
            case 'Chunk':
                pushArray(stack, node.body, scope);
                break;
            case 'LocalStatement':
                pushArray(stack, node.init, scope);
                for (const id of node.variables || []) {
                    if (id && id.type === 'Identifier') {
                        const renamed = randomName();
                        scope.define(id.name, renamed);
                        id.name = renamed;
                    }
                }
                break;
            case 'AssignmentStatement':
                pushArray(stack, node.init, scope);
                pushArray(stack, node.variables, scope);
                break;
            case 'CallStatement':
                stack.push({ node: node.expression, scope });
                break;
            case 'IfStatement':
                for (let i = (node.clauses || []).length - 1; i >= 0; i--) {
                    const clause = node.clauses[i];
                    const clauseScope = new Scope(scope);
                    pushArray(stack, clause.body, clauseScope);
                    if (clause.condition) stack.push({ node: clause.condition, scope });
                }
                break;
            case 'WhileStatement': {
                const child = new Scope(scope);
                pushArray(stack, node.body, child);
                stack.push({ node: node.condition, scope });
                break;
            }
            case 'RepeatStatement': {
                const child = new Scope(scope);
                stack.push({ node: node.condition, scope: child });
                pushArray(stack, node.body, child);
                break;
            }
            case 'ForNumericStatement': {
                stack.push({ node: node.step, scope });
                stack.push({ node: node.end, scope });
                stack.push({ node: node.start, scope });
                const forScope = new Scope(scope);
                if (node.variable) {
                    const renamed = randomName();
                    forScope.define(node.variable.name, renamed);
                    node.variable.name = renamed;
                }
                pushArray(stack, node.body, forScope);
                break;
            }
            case 'ForGenericStatement': {
                pushArray(stack, node.iterators, scope);
                const forScope = new Scope(scope);
                for (const id of node.variables || []) {
                    if (id && id.type === 'Identifier') {
                        const renamed = randomName();
                        forScope.define(id.name, renamed);
                        id.name = renamed;
                    }
                }
                pushArray(stack, node.body, forScope);
                break;
            }
            case 'ReturnStatement':
                pushArray(stack, node.arguments, scope);
                break;
            case 'FunctionDeclaration': {
                if (node.identifier) {
                    if (node.isLocal && node.identifier.type === 'Identifier') {
                        const renamed = randomName();
                        scope.define(node.identifier.name, renamed);
                        node.identifier.name = renamed;
                    } else {
                        node.implicitSelf = node.identifier.type === 'MemberExpression' && node.identifier.indexer === ':';
                        stack.push({ node: node.identifier, scope });
                    }
                }
                const fnScope = new Scope(scope);
                for (const param of node.parameters || []) {
                    if (param && param.type === 'Identifier') {
                        const renamed = randomName();
                        fnScope.define(param.name, renamed);
                        param.name = renamed;
                    }
                }
                pushArray(stack, node.body, fnScope);
                break;
            }
            case 'Identifier':
                transformIdentifier(node, scope, state);
                break;
            case 'StringLiteral':
                encryptStringNode(node, state);
                break;
            case 'TableConstructorExpression':
                pushArray(stack, node.fields, scope);
                break;
            case 'TableKey':
                stack.push({ node: node.value, scope });
                stack.push({ node: node.key, scope });
                break;
            case 'TableKeyString':
                stack.push({ node: node.value, scope });
                if (node.key && node.key.name) {
                    node.type = 'TableKey';
                    node.key = cipher.createDecoderCall(node.key.name);
                    state.hasEncryptedStrings = true;
                }
                break;
            case 'TableValue':
                stack.push({ node: node.value, scope });
                break;
            case 'BinaryExpression':
            case 'LogicalExpression':
                stack.push({ node: node.right, scope });
                stack.push({ node: node.left, scope });
                break;
            case 'UnaryExpression':
                stack.push({ node: node.argument, scope });
                break;
            case 'MemberExpression':
                stack.push({ node: node.base, scope });
                transformMemberExpression(node, state);
                break;
            case 'IndexExpression':
                stack.push({ node: node.index, scope });
                stack.push({ node: node.base, scope });
                break;
            case 'CallExpression':
                if (!transformColonCall(node, state)) stack.push({ node: node.base, scope });
                else stack.push({ node: node.base.base, scope });
                pushArray(stack, node.arguments, scope);
                break;
            case 'TableCallExpression':
                stack.push({ node: node.arguments, scope });
                stack.push({ node: node.base, scope });
                break;
            case 'StringCallExpression':
                stack.push({ node: node.argument, scope });
                stack.push({ node: node.base, scope });
                break;
        }
    }
};

const joinStatements = (nodes) => (nodes || []).map(astToCode).filter(Boolean).join('\n');

const astToCode = (node) => {
    if (!node) return '';
    const baseToCode = (base) => {
        const code = astToCode(base);
        return base && base.type === 'FunctionDeclaration' ? `(${code})` : code;
    };

    switch (node.type) {
        case 'Chunk':
            return joinStatements(node.body);
        case 'LocalStatement': {
            const vars = (node.variables || []).map(astToCode).join(',');
            const inits = (node.init || []).map(astToCode).join(',');
            return inits ? `local ${vars}=${inits}` : `local ${vars}`;
        }
        case 'AssignmentStatement':
            return `${(node.variables || []).map(astToCode).join(',')}=${(node.init || []).map(astToCode).join(',')}`;
        case 'CallStatement':
            return astToCode(node.expression);
        case 'IfStatement': {
            let code = '';
            for (const clause of node.clauses || []) {
                if (clause.type === 'IfClause') code += `if ${astToCode(clause.condition)} then ${joinStatements(clause.body)}`;
                else if (clause.type === 'ElseifClause') code += ` elseif ${astToCode(clause.condition)} then ${joinStatements(clause.body)}`;
                else code += ` else ${joinStatements(clause.body)}`;
            }
            return `${code} end`;
        }
        case 'WhileStatement':
            return `while ${astToCode(node.condition)} do ${joinStatements(node.body)} end`;
        case 'RepeatStatement':
            return `repeat ${joinStatements(node.body)} until ${astToCode(node.condition)}`;
        case 'ForNumericStatement': {
            const step = node.step ? `,${astToCode(node.step)}` : '';
            return `for ${astToCode(node.variable)}=${astToCode(node.start)},${astToCode(node.end)}${step} do ${joinStatements(node.body)} end`;
        }
        case 'ForGenericStatement':
            return `for ${(node.variables || []).map(astToCode).join(',')} in ${(node.iterators || []).map(astToCode).join(',')} do ${joinStatements(node.body)} end`;
        case 'ReturnStatement':
            return `return ${(node.arguments || []).map(astToCode).join(',')}`;
        case 'BreakStatement':
            return 'break';
        case 'FunctionDeclaration': {
            const params = (node.parameters || []).map(astToCode);
            const body = joinStatements(node.body);
            if (!node.identifier) return `function(${params.join(',')}) ${body} end`;
            if (node.isLocal) return `local function ${astToCode(node.identifier)}(${params.join(',')}) ${body} end`;
            const fnParams = node.implicitSelf ? ['self', ...params] : params;
            return `${astToCode(node.identifier)}=function(${fnParams.join(',')}) ${body} end`;
        }
        case 'Identifier':
            return node.name;
        case 'StringLiteral':
            return node.raw || cipher.luaDecimalString(String(node.value || ''));
        case 'NumericLiteral':
            return node.raw || String(node.value);
        case 'BooleanLiteral':
            return node.value ? 'true' : 'false';
        case 'NilLiteral':
            return 'nil';
        case 'VarargLiteral':
            return '...';
        case 'TableConstructorExpression':
            return `{${(node.fields || []).map(astToCode).join(',')}}`;
        case 'TableKey':
            return `[${astToCode(node.key)}]=${astToCode(node.value)}`;
        case 'TableKeyString':
            return `${astToCode(node.key)}=${astToCode(node.value)}`;
        case 'TableValue':
            return astToCode(node.value);
        case 'BinaryExpression':
            if (/^(and|or)$/.test(node.operator)) return `(${astToCode(node.left)} ${node.operator} ${astToCode(node.right)})`;
            return `(${astToCode(node.left)}${node.operator}${astToCode(node.right)})`;
        case 'LogicalExpression':
            return `(${astToCode(node.left)} ${node.operator} ${astToCode(node.right)})`;
        case 'UnaryExpression':
            return `(${node.operator === 'not' ? 'not ' : node.operator}${astToCode(node.argument)})`;
        case 'MemberExpression':
            return `${astToCode(node.base)}${node.indexer}${astToCode(node.identifier)}`;
        case 'IndexExpression':
            return `${astToCode(node.base)}[${astToCode(node.index)}]`;
        case 'CallExpression':
            return `${baseToCode(node.base)}(${(node.arguments || []).map(astToCode).join(',')})`;
        case 'TableCallExpression':
            return `${baseToCode(node.base)}${astToCode(node.arguments)}`;
        case 'StringCallExpression':
            return `${baseToCode(node.base)}${astToCode(node.argument)}`;
        default:
            return '';
    }
};

const minifyLuau = (code) => String(code || '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();

const transformAst = async (code) => {
    const state = { hasEncryptedStrings: false };
    const ast = parse(code);
    await walkAst(ast, state);
    return {
        code: minifyLuau(astToCode(ast)),
        hasEncryptedStrings: state.hasEncryptedStrings
    };
};

module.exports = {
    transformAst,
    astToCode,
    parse
};
