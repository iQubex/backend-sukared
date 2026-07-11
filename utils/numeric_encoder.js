const DIGIT_FREE_GLYPHS = ['⠁', '⠂', '⠃', '⠄', '⠅', '⠆', '⠇', '⠈'];

const luaSafeString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const smallNumberExpression = (value) => {
    const size = Math.max(0, Number(value) || 0);
    if (size === 0) return '#""';
    let text = '';
    for (let i = 0; i < size; i++) text += DIGIT_FREE_GLYPHS[i % DIGIT_FREE_GLYPHS.length];
    return `#${luaSafeString(text)}`;
};

const numberExpression = (value) => {
    const num = Math.trunc(Number(value) || 0);
    if (num < 0) return `-(${numberExpression(Math.abs(num))})`;
    if (num <= 96) return smallNumberExpression(num);

    const base = 16;
    const parts = [];
    let rest = num;
    while (rest > 0) {
        parts.unshift(rest % base);
        rest = Math.floor(rest / base);
    }

    const baseExpr = smallNumberExpression(base);
    let expr = smallNumberExpression(parts.shift() || 0);
    for (const part of parts) {
        expr = `((${expr})*(${baseExpr})+(${smallNumberExpression(part)}))`;
    }
    return expr;
};

const hasDigit = (value) => /[0-9]/.test(String(value || ''));

module.exports = {
    numberExpression,
    hasDigit
};
