const express = require('express');
const cors = require('cors');
const luaparse = require('luaparse');
const { preprocessLuau } = require('./luauPreprocessor');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const YIELD_EVERY_NODES = 1500;
const MAX_OPAQUE_INSERTIONS = 80;
const unicodeAlphabet = ['⠁', '⠂', '⠃', '⠄', '⠅', '⠆', '⠇', '⠈', 'ア', 'イ', 'ウ', 'エ', '一', '二', '三', '四'];
const runtimeNames = new Set(['getfenv', 'lIIll_10O_l', 'lO_10O_lI']);

const generateLookalikeName = () => {
    const startChars = ['l', 'I', 'O', '_'];
    const bodyChars = ['l', 'I', '1', 'O', '0', '_'];
    let name = startChars[Math.floor(Math.random() * startChars.length)];
    const len = Math.floor(Math.random() * 8) + 12;
    for (let i = 1; i < len; i++) {
        name += bodyChars[Math.floor(Math.random() * bodyChars.length)];
    }
    return name;
};

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

const encodeStringToUnicode = (str, key) => {
    let encoded = '';
    for (let i = 0; i < str.length; i++) {
        const encryptedByte = (str.charCodeAt(i) + key) % 256;
        encoded += unicodeAlphabet[Math.floor(encryptedByte / 16)] + unicodeAlphabet[encryptedByte % 16];
    }
    return encoded;
};

const luaDecimalString = (value) => `"${[...value].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

const createDecryptCall = (value, key = Math.floor(Math.random() * 254) + 1) => ({
    type: 'CallExpression',
    base: { type: 'Identifier', name: 'lIIll_10O_l' },
    arguments: [
        { type: 'StringLiteral', value: null, raw: `"${encodeStringToUnicode(value, key)}"` },
        { type: 'NumericLiteral', value: key, raw: String(key) }
    ]
});

const createGetfenvLookup = (name) => ({
    type: 'IndexExpression',
    base: {
        type: 'CallExpression',
        base: { type: 'Identifier', name: 'getfenv' },
        arguments: []
    },
    index: createDecryptCall(name)
});

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
            if (Object.prototype.hasOwnProperty.call(scope.bindings, name)) {
                return scope.bindings[name];
            }
            scope = scope.parent;
        }
        return null;
    }
}

const createRuntimeScope = () => {
    const scope = new Scope();
    for (const name of runtimeNames) {
        scope.define(name, name);
    }
    return scope;
};

const isIdentifierStart = (char) => /[A-Za-z_]/.test(char || '');
const isIdentifierPart = (char) => /[A-Za-z0-9_]/.test(char || '');
const isSpace = (char) => /\s/.test(char || '');

const skipQuotedString = (code, index, quote) => {
    index++;
    while (index < code.length) {
        const char = code[index];
        if (char === '\\') {
            index += 2;
            continue;
        }
        index++;
        if (char === quote) break;
    }
    return index;
};

const skipLongBracket = (code, index) => {
    const match = code.slice(index).match(/^\[(=*)\[/);
    if (!match) return index + 1;
    const close = `]${match[1]}]`;
    const end = code.indexOf(close, index + match[0].length);
    return end === -1 ? code.length : end + close.length;
};

const stripComments = (code) => {
    let out = '';
    for (let i = 0; i < code.length;) {
        const char = code[i];
        const next = code[i + 1];
        if ((char === '"' || char === "'") && next !== undefined) {
            const end = skipQuotedString(code, i, char);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '[' && /^(\[=*\[)/.test(code.slice(i))) {
            const end = skipLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '-' && next === '-') {
            if (code[i + 2] === '[' && /^(\[=*\[)/.test(code.slice(i + 2))) {
                i = skipLongBracket(code, i + 2);
                continue;
            }
            while (i < code.length && code[i] !== '\n') i++;
            out += '\n';
            continue;
        }
        out += char;
        i++;
    }
    return out;
};

const readBalanced = (code, index, open, close) => {
    let depth = 1;
    let i = index + 1;
    while (i < code.length) {
        const char = code[i];
        if (char === '"' || char === "'") {
            i = skipQuotedString(code, i, char);
            continue;
        }
        if (char === '`') {
            i = skipBacktick(code, i);
            continue;
        }
        if (char === '[' && /^(\[=*\[)/.test(code.slice(i))) {
            i = skipLongBracket(code, i);
            continue;
        }
        if (char === open) depth++;
        if (char === close) depth--;
        i++;
        if (depth === 0) return { content: code.slice(index + 1, i - 1), end: i };
    }
    return { content: code.slice(index + 1), end: code.length };
};

const skipBacktick = (code, index) => {
    index++;
    while (index < code.length) {
        const char = code[index];
        if (char === '\\') {
            index += 2;
            continue;
        }
        if (char === '{') {
            index = readBalanced(code, index, '{', '}').end;
            continue;
        }
        index++;
        if (char === '`') break;
    }
    return index;
};

const convertInterpolatedString = (raw) => {
    const parts = [];
    let text = '';
    for (let i = 1; i < raw.length - 1;) {
        const char = raw[i];
        if (char === '\\') {
            text += raw.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (char === '{') {
            if (text) {
                parts.push(luaDecimalString(parseLuaString(`"${text}"`)));
                text = '';
            }
            const balanced = readBalanced(raw, i, '{', '}');
            parts.push(`tostring(${preprocessLuau(balanced.content)})`);
            i = balanced.end;
            continue;
        }
        text += char;
        i++;
    }
    if (text || parts.length === 0) {
        parts.push(luaDecimalString(parseLuaString(`"${text}"`)));
    }
    return `(${parts.join('..')})`;
};

const convertAllInterpolatedStrings = (code) => {
    let out = '';
    for (let i = 0; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            const end = skipQuotedString(code, i, char);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '[' && /^(\[=*\[)/.test(code.slice(i))) {
            const end = skipLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '`') {
            const end = skipBacktick(code, i);
            out += convertInterpolatedString(code.slice(i, end));
            i = end;
            continue;
        }
        out += char;
        i++;
    }
    return out;
};

const removeLuauTypes = (code) => {
    code = code.replace(/\)\s*:\s*[^=\n;]*?\s+(?=(return|local|if|for|while|repeat|do|end)\b)/g, ') ');
    code = code.replace(/:\s*\([^)\n]*\)\s*->\s*[^=,\n;)]+/g, '');
    let out = '';
    for (let i = 0; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            const end = skipQuotedString(code, i, char);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '[' && /^(\[=*\[)/.test(code.slice(i))) {
            const end = skipLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === ':' && code[i + 1] !== ':' && code[i - 1] !== ':') {
            let look = i + 1;
            while (isSpace(code[look])) look++;
            if (isIdentifierStart(code[look])) {
                let end = look + 1;
                while (isIdentifierPart(code[end])) end++;
                let afterName = end;
                while (isSpace(code[afterName])) afterName++;
                if (code[afterName] === '(') {
                    out += char;
                    i++;
                    continue;
                }
            }
            const prev = out.match(/[A-Za-z0-9_\)]\s*$/);
            if (prev) {
                i++;
                while (isSpace(code[i])) i++;
                let angle = 0;
                while (i < code.length) {
                    const c = code[i];
                    if (c === '<' || c === '{' || c === '(') angle++;
                    if (c === '>' || c === '}' || c === ')') {
                        if (angle === 0 && c === ')') break;
                        angle = Math.max(0, angle - 1);
                    }
                    if (angle === 0 && /[,)=\n;]/.test(c)) break;
                    i++;
                }
                continue;
            }
        }
        if (char === '-' && code[i + 1] === '>') {
            i += 2;
            while (isSpace(code[i])) i++;
            let angle = 0;
            while (i < code.length) {
                const c = code[i];
                if (c === '<' || c === '{' || c === '(') angle++;
                if (c === '>' || c === '}' || c === ')') angle = Math.max(0, angle - 1);
                if (angle === 0 && /\b(local|if|then|do|return|end|else|elseif|for|while|repeat)\b/.test(code.slice(i))) break;
                if (angle === 0 && /[\n;]/.test(c)) break;
                i++;
            }
            continue;
        }
        out += char;
        i++;
    }
    return out.replace(/\b(export\s+)?type\s+[A-Za-z_][A-Za-z0-9_]*\s*=[^\n;]*/g, '');
};

const stripBalancedAngle = (code, index) => {
    let depth = 1;
    let i = index + 1;
    while (i < code.length) {
        const char = code[i];
        if (char === '"' || char === "'") {
            i = skipQuotedString(code, i, char);
            continue;
        }
        if (char === '<') depth++;
        if (char === '>') depth--;
        i++;
        if (depth === 0) return i;
    }
    return index;
};

const stripLuauGenerics = (code) => {
    let out = '';
    for (let i = 0; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            const end = skipQuotedString(code, i, char);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '[' && /^(\[=*\[)/.test(code.slice(i))) {
            const end = skipLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '<' && /[A-Za-z0-9_]\s*$/.test(out)) {
            const end = stripBalancedAngle(code, i);
            if (end > i) {
                let look = end;
                while (isSpace(code[look])) look++;
                if (code[look] === '(' || code[look] === '.' || code[look] === ':') {
                    i = end;
                    continue;
                }
            }
        }
        out += char;
        i++;
    }
    return out;
};

const stripLuauCasts = (code) => {
    code = code
        .replace(/\s*::\s*[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:<[^>\n]*>)?/g, '')
        .replace(/\s*::\s*\{[^}\n]*\}/g, '');
    let out = '';
    for (let i = 0; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            const end = skipQuotedString(code, i, char);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '[' && /^(\[=*\[)/.test(code.slice(i))) {
            const end = skipLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === ':' && code[i + 1] === ':') {
            i += 2;
            while (isSpace(code[i])) i++;
            let depth = 0;
            let lastTypeIndex = i;
            while (i < code.length) {
                const c = code[i];
                if (c === '<' || c === '{' || c === '(') depth++;
                if (c === '>' || c === '}' || c === ')') {
                    if (depth === 0 && c === ')') break;
                    depth = Math.max(0, depth - 1);
                }
                if (depth === 0 && /[,;\n\]\}]/.test(c)) break;
                if (depth === 0 && isSpace(c)) {
                    const lookahead = code.slice(i);
                    if (/^\s*(and|or|then|do|else|elseif|end|return|local)\b/.test(lookahead)) break;
                    lastTypeIndex = i;
                }
                i++;
            }
            if (i < code.length && isSpace(code[i]) && lastTypeIndex > 0) {
                i = lastTypeIndex;
            }
            continue;
        }
        out += char;
        i++;
    }
    return out;
};

const convertCompoundAssignments = (code) => {
    return code.replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*(?:\s*(?:\.|:)\s*[A-Za-z_][A-Za-z0-9_]*|\s*\[[^\n\]]+\])*)\s*(\+=|-=|\*=|\/=|%=|\^=)\s*(.+)$/gm, (_, indent, lhs, op, rhs) => {
        return `${indent}${lhs} = ${lhs} ${op[0]} (${rhs})`;
    });
};

const legacyPreprocessLuau = (code) => {
    let out = stripComments(code);
    out = convertAllInterpolatedStrings(out);
    out = stripLuauGenerics(out);
    out = stripLuauCasts(out);
    out = removeLuauTypes(out);
    out = convertCompoundAssignments(out);
    out = out.replace(/\bcontinue\b/g, 'break');
    return out;
};

const parseLuaString = (raw) => {
    if (!raw) return '';
    const long = raw.match(/^\[(=*)\[([\s\S]*)\]\1\]$/);
    if (long) return long[2];
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
        const char = raw[i];
        if (char !== '\\') {
            out += char;
            continue;
        }
        const next = raw[++i];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next === 'a') out += '\x07';
        else if (next === 'b') out += '\b';
        else if (next === 'f') out += '\f';
        else if (next === 'v') out += '\v';
        else if (next === 'z') {
            while (/\s/.test(raw[i + 1] || '')) i++;
        } else if (next === 'x') {
            const hex = raw.slice(i + 1, i + 3);
            out += String.fromCharCode(parseInt(hex, 16) || 0);
            i += 2;
        } else if (/[0-9]/.test(next)) {
            let digits = next;
            while (digits.length < 3 && /[0-9]/.test(raw[i + 1] || '')) digits += raw[++i];
            out += String.fromCharCode(Math.min(255, parseInt(digits, 10) || 0));
        } else {
            out += next || '';
        }
    }
    return out;
};

const encryptStringNode = (node, state) => {
    const value = node.value !== undefined && node.value !== null ? String(node.value) : parseLuaString(node.raw);
    if (value.length === 0) return;
    const call = createDecryptCall(value);
    state.hasStrings = true;
    node.type = 'CallExpression';
    node.base = call.base;
    node.arguments = call.arguments;
    delete node.value;
    delete node.raw;
};

const transformIdentifier = (node, scope, state) => {
    const resolved = scope.lookup(node.name);
    if (resolved !== null) {
        node.name = resolved;
        return;
    }
    if (runtimeNames.has(node.name)) return;
    const lookup = createGetfenvLookup(node.name);
    state.hasStrings = true;
    Object.keys(node).forEach(key => delete node[key]);
    Object.assign(node, lookup);
};

const transformMemberExpression = (node, state) => {
    if (!node.identifier || !node.identifier.name) return;
    const lookup = createDecryptCall(node.identifier.name);
    state.hasStrings = true;
    node.type = 'IndexExpression';
    node.index = lookup;
    delete node.identifier;
    delete node.indexer;
};

const transformColonCall = (node, state) => {
    const base = node.base;
    if (!base || base.type !== 'MemberExpression' || base.indexer !== ':' || !base.identifier) return false;
    const methodObj = base.base;
    const selfArg = JSON.parse(JSON.stringify(methodObj));
    node.arguments = [selfArg, ...(node.arguments || [])];
    node.base = {
        type: 'IndexExpression',
        base: methodObj,
        index: createDecryptCall(base.identifier.name)
    };
    state.hasStrings = true;
    return true;
};

const pushArray = (stack, items, scope) => {
    if (!items) return;
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]) stack.push({ node: items[i], scope });
    }
};

const walkAstAsync = async (root, rootScope, state) => {
    const stack = [{ node: root, scope: rootScope }];
    let processed = 0;
    while (stack.length) {
        const frame = stack.pop();
        const node = frame.node;
        const scope = frame.scope;
        if (!node) continue;
        if (++processed % YIELD_EVERY_NODES === 0) await yieldToLoop();

        switch (node.type) {
            case 'Chunk':
                pushArray(stack, node.body, scope);
                break;
            case 'LocalStatement':
                pushArray(stack, node.init, scope);
                for (const id of node.variables || []) {
                    if (id && id.type === 'Identifier') {
                        const newName = generateLookalikeName();
                        scope.define(id.name, newName);
                        id.name = newName;
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
                const childScope = new Scope(scope);
                pushArray(stack, node.body, childScope);
                stack.push({ node: node.condition, scope });
                break;
            }
            case 'RepeatStatement': {
                const childScope = new Scope(scope);
                stack.push({ node: node.condition, scope: childScope });
                pushArray(stack, node.body, childScope);
                break;
            }
            case 'ForNumericStatement': {
                stack.push({ node: node.step, scope });
                stack.push({ node: node.end, scope });
                stack.push({ node: node.start, scope });
                const forScope = new Scope(scope);
                if (node.variable) {
                    const newName = generateLookalikeName();
                    forScope.define(node.variable.name, newName);
                    node.variable.name = newName;
                }
                pushArray(stack, node.body, forScope);
                break;
            }
            case 'ForGenericStatement': {
                pushArray(stack, node.iterators, scope);
                const forScope = new Scope(scope);
                for (const id of node.variables || []) {
                    if (id && id.type === 'Identifier') {
                        const newName = generateLookalikeName();
                        forScope.define(id.name, newName);
                        id.name = newName;
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
                        const newName = generateLookalikeName();
                        scope.define(node.identifier.name, newName);
                        node.identifier.name = newName;
                    } else {
                        node.implicitSelf = node.identifier.type === 'MemberExpression' && node.identifier.indexer === ':';
                        stack.push({ node: node.identifier, scope });
                    }
                }
                const fnScope = new Scope(scope);
                for (const param of node.parameters || []) {
                    if (param && param.type === 'Identifier') {
                        const newName = generateLookalikeName();
                        fnScope.define(param.name, newName);
                        param.name = newName;
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
                    node.key = createDecryptCall(node.key.name);
                    state.hasStrings = true;
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
                if (!transformColonCall(node, state)) {
                    stack.push({ node: node.base, scope });
                } else {
                    stack.push({ node: node.base.base, scope });
                }
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

const astToCode = (node) => {
    if (!node) return '';
    const baseToCode = (base) => {
        const code = astToCode(base);
        return base && base.type === 'FunctionDeclaration' ? `(${code})` : code;
    };

    switch (node.type) {
        case 'Chunk':
            return (node.body || []).map(astToCode).join(' ');
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
                if (clause.type === 'IfClause') code += `if ${astToCode(clause.condition)} then ${(clause.body || []).map(astToCode).join(' ')}`;
                else if (clause.type === 'ElseifClause') code += ` elseif ${astToCode(clause.condition)} then ${(clause.body || []).map(astToCode).join(' ')}`;
                else code += ` else ${(clause.body || []).map(astToCode).join(' ')}`;
            }
            return `${code} end`;
        }
        case 'WhileStatement':
            return `while ${astToCode(node.condition)} do ${(node.body || []).map(astToCode).join(' ')} end`;
        case 'RepeatStatement':
            return `repeat ${(node.body || []).map(astToCode).join(' ')} until ${astToCode(node.condition)}`;
        case 'ForNumericStatement': {
            const step = node.step ? `,${astToCode(node.step)}` : '';
            return `for ${astToCode(node.variable)}=${astToCode(node.start)},${astToCode(node.end)}${step} do ${(node.body || []).map(astToCode).join(' ')} end`;
        }
        case 'ForGenericStatement':
            return `for ${(node.variables || []).map(astToCode).join(',')} in ${(node.iterators || []).map(astToCode).join(',')} do ${(node.body || []).map(astToCode).join(' ')} end`;
        case 'ReturnStatement':
            return `return ${(node.arguments || []).map(astToCode).join(',')}`;
        case 'BreakStatement':
            return 'break';
        case 'FunctionDeclaration': {
            const params = (node.parameters || []).map(astToCode);
            const body = (node.body || []).map(astToCode).join(' ');
            if (!node.identifier) return `function(${params.join(',')}) ${body} end`;
            if (node.isLocal) return `local function ${astToCode(node.identifier)}(${params.join(',')}) ${body} end`;
            const fnParams = node.implicitSelf ? ['self', ...params] : params;
            return `${astToCode(node.identifier)}=function(${fnParams.join(',')}) ${body} end`;
        }
        case 'Identifier':
            return node.name;
        case 'StringLiteral':
            return node.raw || luaDecimalString(String(node.value || ''));
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

const getErrorContext = (code, err) => {
    const match = String(err.message || '').match(/\[(\d+):(\d+)\]/);
    if (!match) return '';
    const lineNo = Number(match[1]);
    const lines = code.split('\n');
    const start = Math.max(1, lineNo - 2);
    const end = Math.min(lines.length, lineNo + 2);
    const excerpt = [];
    for (let line = start; line <= end; line++) {
        excerpt.push(`${line}: ${lines[line - 1] || ''}`);
    }
    return excerpt.join(' | ');
};

const parseChunk = (code) => {
    try {
        return luaparse.parse(code, { comments: false, scope: false, luaVersion: '5.2' });
    } catch (err) {
        const context = getErrorContext(code, err);
        err.message = context ? `${err.message} | preprocessed: ${context}` : err.message;
        throw err;
    }
};

const transformLuaSnippet = async (code, state) => {
    const ast = parseChunk(preprocessLuau(code));
    await walkAstAsync(ast, createRuntimeScope(), state);
    return astToCode(ast);
};

const generateOpaquePredicate = () => {
    const x = Math.floor(Math.random() * 50) + 5;
    return `if (math.sqrt(${x * x}) == ${x}) then local ${generateLookalikeName()} = math.floor(math.pi) end`;
};

const insertOpaquePredicatesAsync = async (code, state) => {
    const lines = code.split('\n');
    const result = [];
    let inserted = 0;
    for (let i = 0; i < lines.length; i++) {
        result.push(lines[i]);
        const line = lines[i].trim();
        const canInsert = line && !/(\bthen|\bdo|\belse|\belseif|\band|\bor|[+\-*/,%^.]$)/.test(line);
        if (canInsert && inserted < MAX_OPAQUE_INSERTIONS && Math.random() < 0.12) {
            result.push(await transformLuaSnippet(generateOpaquePredicate(), state));
            inserted++;
        }
        if (i % 800 === 0) await yieldToLoop();
    }
    return result.join('\n');
};

const createDecryptRuntime = () => {
    const stringLookup = luaDecimalString('string');
    const tableLookup = luaDecimalString('table');
    const gmatchLookup = luaDecimalString('gmatch');
    const insertLookup = luaDecimalString('insert');
    const charLookup = luaDecimalString('char');

    return `local function lIIll_10O_l(s,k)local lS=getfenv()[${stringLookup}]local lT=getfenv()[${tableLookup}]local lM={["⠁"]=0,["⠂"]=1,["⠃"]=2,["⠄"]=3,["⠅"]=4,["⠆"]=5,["⠇"]=6,["⠈"]=7,["ア"]=8,["イ"]=9,["ウ"]=10,["エ"]=11,["一"]=12,["二"]=13,["三"]=14,["四"]=15}local b={}local t=nil for c in lS[${gmatchLookup}](s,"([%z\\1-\\127\\194-\\244][\\128-\\191]*)")do local v=lM[c]if v~=nil then if t==nil then t=v else lT[${insertLookup}](b,t*16+v)t=nil end end end local r=""for i=1,#b do r=r..lS[${charLookup}]((b[i]-k)%256)end return r end `;
};

const createAntiTamper = () => (
    'local function lO_10O_lI() ' +
    'if not debug or type(debug) ~= "table" or not debug.info then while true do end end ' +
    'if debug.info(debug.info, "s") ~= "[C]" then while true do end end ' +
    'local f = function() end if debug.info(f, "s") == "[C]" then while true do end end ' +
    'local list = {string.char, pcall, xpcall, unpack, setmetatable, tostring, tonumber} ' +
    'if getfenv then table.insert(list, getfenv) end ' +
    'for i = 1, #list do if type(list[i]) ~= "function" or debug.info(list[i], "s") ~= "[C]" then while true do end end end ' +
    'end lO_10O_lI() '
);

const minifyLuau = (code) => code.replace(/\s+/g, ' ').trim();

const obfuscateAsync = async (source) => {
    const cleaned = preprocessLuau(source);
    const ast = parseChunk(cleaned);
    const state = { hasStrings: false };
    await walkAstAsync(ast, createRuntimeScope(), state);

    let obfCode = astToCode(ast);
    obfCode = await transformLuaSnippet(createAntiTamper(), state) + obfCode;
    obfCode = await insertOpaquePredicatesAsync(obfCode, state);
    if (state.hasStrings) obfCode = createDecryptRuntime() + obfCode;
    return minifyLuau(obfCode);
};

app.post('/obfuscate', async (req, res) => {
    const code = req.body && req.body.code;
    if (!code) return res.status(400).send({ error: 'Kod gönder kanka!' });

    try {
        const obfuscated = await obfuscateAsync(String(code));
        res.json({
            status: 'success',
            original_length: code.length,
            obfuscated
        });
    } catch (err) {
        res.status(500).json({
            error: `Obfuscation sırasında bir hata oluştu: ${err.message}`
        });
    }
});

app.listen(PORT, () => console.log(`Obfuscator API ${PORT} portunda ayakta!`));
