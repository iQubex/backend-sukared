const isIdentPart = (char) => /[A-Za-z0-9_]/.test(char || '');

const startsKeywordAfterExpression = (source, index) => /^(and|or|then|do|else|elseif|end|until|in|return|local|function|while|if|for|repeat|not)\b/.test(source.slice(index));

const readQuoted = (code, index) => {
    const quote = code[index];
    let out = quote;
    let i = index + 1;
    while (i < code.length) {
        const char = code[i];
        out += char;
        i++;
        if (char === '\\' && i < code.length) {
            out += code[i++];
            continue;
        }
        if (char === quote) break;
    }
    return { text: out, end: i };
};

const readLongBracket = (code, index) => {
    const match = code.slice(index).match(/^\[(=*)\[/);
    if (!match) return null;
    const close = `]${match[1]}]`;
    const end = code.indexOf(close, index + match[0].length);
    const finalEnd = end === -1 ? code.length : end + close.length;
    return { text: code.slice(index, finalEnd), end: finalEnd };
};

const shouldKeepSpace = (left, right) => {
    if (!left || !right) return false;
    if (isIdentPart(left) && isIdentPart(right)) return true;
    if ('+-*/%^'.includes(left) && right === '#') return true;
    if ((left === '.' && right === '.') || (left === '-' && right === '-')) return true;
    return false;
};

const minifyLuau = (code) => {
    const source = String(code || '');
    let out = '';

    for (let i = 0; i < source.length;) {
        const char = source[i];

        if (char === '"' || char === "'") {
            const quoted = readQuoted(source, i);
            out += quoted.text;
            i = quoted.end;
            continue;
        }

        if (char === '[') {
            const long = readLongBracket(source, i);
            if (long) {
                out += long.text;
                i = long.end;
                continue;
            }
        }

        if (/\s/.test(char)) {
            let end = i + 1;
            while (/\s/.test(source[end] || '')) end++;
            if (shouldKeepSpace(out[out.length - 1], source[end]) || startsKeywordAfterExpression(source, end)) out += ' ';
            i = end;
            continue;
        }

        out += char;
        i++;
    }

    return out.trim();
};

module.exports = {
    minifyLuau
};
