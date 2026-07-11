const KEYWORDS_AFTER_TYPE = new Set([
    'and', 'or', 'then', 'do', 'else', 'elseif', 'end', 'return', 'local',
    'function', 'if', 'for', 'while', 'repeat', 'until', 'in'
]);

const isSpace = (char) => /\s/.test(char || '');
const isIdentStart = (char) => /[A-Za-z_]/.test(char || '');
const isIdentPart = (char) => /[A-Za-z0-9_]/.test(char || '');

const luaDecimalString = (value) => `"${[...value].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

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

const readQuoted = (code, index) => {
    const quote = code[index];
    let i = index + 1;
    while (i < code.length) {
        if (code[i] === '\\') {
            i += 2;
            continue;
        }
        i++;
        if (code[i - 1] === quote) break;
    }
    return i;
};

const readLongBracket = (code, index) => {
    const match = code.slice(index).match(/^\[(=*)\[/);
    if (!match) return index + 1;
    const close = `]${match[1]}]`;
    const end = code.indexOf(close, index + match[0].length);
    return end === -1 ? code.length : end + close.length;
};

const readIdentifier = (code, index) => {
    if (!isIdentStart(code[index])) return { value: '', end: index };
    let end = index + 1;
    while (isIdentPart(code[end])) end++;
    return { value: code.slice(index, end), end };
};

const readBalanced = (code, index, open, close) => {
    let depth = 1;
    let i = index + 1;
    while (i < code.length) {
        const char = code[i];
        if (char === '"' || char === "'") {
            i = readQuoted(code, i);
            continue;
        }
        if (char === '`') {
            i = readBacktick(code, i);
            continue;
        }
        if (char === '[' && /^\[=*\[/.test(code.slice(i))) {
            i = readLongBracket(code, i);
            continue;
        }
        if (char === open) depth++;
        else if (char === close) depth--;
        i++;
        if (depth === 0) return { content: code.slice(index + 1, i - 1), end: i };
    }
    return { content: code.slice(index + 1), end: code.length };
};

const readBacktick = (code, index) => {
    let i = index + 1;
    while (i < code.length) {
        if (code[i] === '\\') {
            i += 2;
            continue;
        }
        if (code[i] === '{') {
            i = readBalanced(code, i, '{', '}').end;
            continue;
        }
        i++;
        if (code[i - 1] === '`') break;
    }
    return i;
};

const stripComments = (code) => {
    let out = '';
    for (let i = 0; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            const end = readQuoted(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '`') {
            const end = readBacktick(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '[' && /^\[=*\[/.test(code.slice(i))) {
            const end = readLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '-' && code[i + 1] === '-') {
            if (code[i + 2] === '[' && /^\[=*\[/.test(code.slice(i + 2))) {
                i = readLongBracket(code, i + 2);
            } else {
                while (i < code.length && code[i] !== '\n') i++;
            }
            if (code[i] === '\n') out += '\n';
            continue;
        }
        out += char;
        i++;
    }
    return out;
};

const convertInterpolatedString = (raw) => {
    const parts = [];
    let text = '';
    for (let i = 1; i < raw.length - 1;) {
        if (raw[i] === '\\') {
            text += raw.slice(i, i + 2);
            i += 2;
            continue;
        }
        if (raw[i] === '{') {
            if (text) {
                parts.push(luaDecimalString(parseLuaString(`"${text}"`)));
                text = '';
            }
            const balanced = readBalanced(raw, i, '{', '}');
            parts.push(`tostring(${preprocessLuau(balanced.content)})`);
            i = balanced.end;
            continue;
        }
        text += raw[i++];
    }
    if (text || parts.length === 0) parts.push(luaDecimalString(parseLuaString(`"${text}"`)));
    return `(${parts.join('..')})`;
};

const convertInterpolatedStrings = (code) => {
    let out = '';
    for (let i = 0; i < code.length;) {
        if (code[i] === '"' || code[i] === "'") {
            const end = readQuoted(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (code[i] === '[' && /^\[=*\[/.test(code.slice(i))) {
            const end = readLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (code[i] === '`') {
            const end = readBacktick(code, i);
            out += convertInterpolatedString(code.slice(i, end));
            i = end;
            continue;
        }
        out += code[i++];
    }
    return out;
};

const readType = (code, index, stopChars = new Set([',', '=', ';', '\n', ')'])) => {
    let i = index;
    let angle = 0;
    let curly = 0;
    let paren = 0;
    let square = 0;
    while (i < code.length) {
        const char = code[i];
        if (char === '"' || char === "'") {
            i = readQuoted(code, i);
            continue;
        }
        if (char === '<') angle++;
        else if (char === '>' && angle > 0) angle--;
        else if (char === '{') curly++;
        else if (char === '}' && curly > 0) curly--;
        else if (char === '(') paren++;
        else if (char === ')' && paren > 0) paren--;
        else if (char === '[') square++;
        else if (char === ']' && square > 0) square--;

        if (angle === 0 && curly === 0 && paren === 0 && square === 0) {
            if (stopChars.has(char)) break;
            const ident = readIdentifier(code, i);
            if (ident.value && KEYWORDS_AFTER_TYPE.has(ident.value)) break;
        }
        i++;
    }
    return i;
};

const stripTypeAliases = (code) => {
    return code.replace(/^\s*(export\s+)?type\s+[A-Za-z_][A-Za-z0-9_]*\s*=[^\n]*(\n|$)/gm, '\n');
};

const stripTypesAndCasts = (code) => {
    let out = '';
    for (let i = 0; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            const end = readQuoted(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '`') {
            const end = readBacktick(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '[' && /^\[=*\[/.test(code.slice(i))) {
            const end = readLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === ':' && code[i + 1] === ':') {
            i = readType(code, i + 2, new Set([',', ';', '\n', ')', ']']));
            continue;
        }
        if (char === ':' && code[i - 1] !== ':' && code[i + 1] !== ':') {
            let look = i + 1;
            while (isSpace(code[look])) look++;
            const ident = readIdentifier(code, look);
            let afterIdent = ident.end;
            while (isSpace(code[afterIdent])) afterIdent++;
            if (ident.value && code[afterIdent] === '(') {
                out += char;
                i++;
                continue;
            }
            const stopChars = code[look] === '('
                ? new Set([',', '=', ';', '\n'])
                : new Set([',', '=', ';', '\n', ')']);
            i = readType(code, i + 1, stopChars);
            continue;
        }
        if (char === '-' && code[i + 1] === '>') {
            i = readType(code, i + 2, new Set([';', '\n']));
            continue;
        }
        out += char;
        i++;
    }
    return out;
};

const stripGenerics = (code) => {
    let out = '';
    for (let i = 0; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            const end = readQuoted(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '[' && /^\[=*\[/.test(code.slice(i))) {
            const end = readLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '<' && /[A-Za-z0-9_]\s*$/.test(out)) {
            let end = i + 1;
            let depth = 1;
            while (end < code.length && depth > 0) {
                if (code[end] === '"' || code[end] === "'") {
                    end = readQuoted(code, end);
                    continue;
                }
                if (code[end] === '<') depth++;
                else if (code[end] === '>') depth--;
                end++;
            }
            let look = end;
            while (isSpace(code[look])) look++;
            if (depth === 0 && (code[look] === '(' || code[look] === '.' || code[look] === ':')) {
                i = end;
                continue;
            }
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

const isContinuationStart = (line) => /^(\.\.|[+\-*/%^]|and\b|or\b)/.test(line.trim());

const isOpenExpressionLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/(^|[^=<>~])=$/.test(trimmed)) return true;
    if (/(\.\.|[+\-*/%^]|\(|\{|\[|,)$/.test(trimmed)) return true;
    return false;
};

const normalizeMultilineContinuations = (code) => {
    const lines = String(code || '').split('\n');
    const out = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (
            out.length > 0
            && trimmed
            && (isContinuationStart(trimmed) || isOpenExpressionLine(out[out.length - 1]))
        ) {
            out[out.length - 1] += ` ${trimmed}`;
        } else {
            out.push(line);
        }
    }
    return out.join('\n');
};

const findTopLevelKeyword = (code, keyword, start = 0) => {
    let paren = 0;
    let curly = 0;
    let square = 0;
    for (let i = start; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            i = readQuoted(code, i);
            continue;
        }
        if (char === '`') {
            i = readBacktick(code, i);
            continue;
        }
        if (char === '[' && /^\[=*\[/.test(code.slice(i))) {
            i = readLongBracket(code, i);
            continue;
        }
        if (char === '(') paren++;
        else if (char === ')' && paren > 0) {
            paren--;
            i++;
            continue;
        }
        else if (char === '{') curly++;
        else if (char === '}' && curly > 0) curly--;
        else if (char === '[') square++;
        else if (char === ']' && square > 0) {
            square--;
            i++;
            continue;
        }

        if (paren === 0 && curly === 0 && square === 0 && code.startsWith(keyword, i)) {
            const before = code[i - 1];
            const after = code[i + keyword.length];
            if (!isIdentPart(before) && !isIdentPart(after)) return i;
        }
        i++;
    }
    return -1;
};

const findExpressionEnd = (code, start) => {
    let paren = 0;
    let curly = 0;
    let square = 0;
    for (let i = start; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            i = readQuoted(code, i);
            continue;
        }
        if (char === '`') {
            i = readBacktick(code, i);
            continue;
        }
        if (char === '[' && /^\[=*\[/.test(code.slice(i))) {
            i = readLongBracket(code, i);
            continue;
        }
        if (char === '(') paren++;
        else if (char === ')' && paren > 0) {
            paren--;
            i++;
            continue;
        }
        else if (char === '{') curly++;
        else if (char === '}' && curly > 0) curly--;
        else if (char === '[') square++;
        else if (char === ']' && square > 0) {
            square--;
            i++;
            continue;
        }
        if (paren === 0 && curly === 0 && square === 0 && (char === '\n' || char === ';' || char === ',' || char === ')')) {
            return i;
        }
        i++;
    }
    return code.length;
};

const convertLuauIfExpressions = (code) => {
    let out = '';
    for (let i = 0; i < code.length;) {
        const char = code[i];
        if (char === '"' || char === "'") {
            const end = readQuoted(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '`') {
            const end = readBacktick(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (char === '[' && /^\[=*\[/.test(code.slice(i))) {
            const end = readLongBracket(code, i);
            out += code.slice(i, end);
            i = end;
            continue;
        }
        if (code.startsWith('if', i) && !isIdentPart(code[i - 1]) && !isIdentPart(code[i + 2])) {
            const prev = out.trimEnd().slice(-1);
            if (!prev || !/[=({[,]/.test(prev)) {
                out += code[i++];
                continue;
            }
            const thenIndex = findTopLevelKeyword(code, 'then', i + 2);
            if (thenIndex !== -1) {
                const elseIndex = findTopLevelKeyword(code, 'else', thenIndex + 4);
                if (elseIndex !== -1) {
                    const end = findExpressionEnd(code, elseIndex + 4);
                    const condition = code.slice(i + 2, thenIndex).trim();
                    const truthy = code.slice(thenIndex + 4, elseIndex).trim();
                    const falsy = code.slice(elseIndex + 4, end).trim();
                    out += `(function() if ${condition} then return ${truthy} else return ${falsy} end end)()`;
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

const normalizeLuauOperators = (code) => {
    return code
        .replace(/\bcontinue\b/g, 'break')
        .replace(/~=/g, '~=');
};

function preprocessLuau(code) {
    let out = String(code || '');
    out = stripComments(out);
    out = convertInterpolatedStrings(out);
    out = stripTypeAliases(out);
    out = stripGenerics(out);
    out = stripTypesAndCasts(out);
    out = convertCompoundAssignments(out);
    out = normalizeMultilineContinuations(out);
    out = convertLuauIfExpressions(out);
    out = normalizeLuauOperators(out);
    return out;
}

module.exports = {
    preprocessLuau,
    parseLuaString,
    luaDecimalString
};
