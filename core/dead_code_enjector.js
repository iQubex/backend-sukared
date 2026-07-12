const { numberExpression } = require('../utils/numeric_encoder');

const MAX_INSERTIONS = 160;
const WATERMARKS = [
    'Obfuscated By Sukared',
    'Dont try its very hard',
    'SukaRed v1.0 owns you'
];

const DIGIT_FREE_WATERMARKS = [
    'Obfuscated By Sukared',
    'Dont try its very hard',
    'SukaRed owns you'
];

const randomName = () => {
    const chars = ['l', 'I', 'O', '_'];
    let value = '_';
    for (let i = 0; i < 16; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
};

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const num = (options, value) => options.digitFree ? numberExpression(value) : String(value);

const startsBlockBoundary = (line) => /^(else|elseif|end|until)\b/.test(String(line || '').trim());

const endsWithOpenExpression = (line) => /(\bthen|\bdo|\belse|\belseif|\band|\bor|[+\-*/,%^.]|\(|\{|\[)$/.test(line);

const isTerminatingStatement = (line) => /^(return|break|continue)\b/.test(String(line || '').trim());

const createScanState = () => ({
    paren: 0,
    curly: 0,
    square: 0,
    longClose: null
});

const scanLine = (line, state) => {
    const text = String(line || '');
    for (let i = 0; i < text.length;) {
        if (state.longClose) {
            const closeIndex = text.indexOf(state.longClose, i);
            if (closeIndex === -1) return state;
            i = closeIndex + state.longClose.length;
            state.longClose = null;
            continue;
        }

        const char = text[i];

        if (char === '"' || char === "'") {
            const quote = char;
            i++;
            while (i < text.length) {
                if (text[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (text[i] === quote) {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }

        if (char === '[') {
            const long = text.slice(i).match(/^\[(=*)\[/);
            if (long) {
                state.longClose = `]${long[1]}]`;
                i += long[0].length;
                continue;
            }
            state.square++;
            i++;
            continue;
        }

        if (char === ']') {
            state.square = Math.max(0, state.square - 1);
            i++;
            continue;
        }

        if (char === '(') state.paren++;
        else if (char === ')') state.paren = Math.max(0, state.paren - 1);
        else if (char === '{') state.curly++;
        else if (char === '}') state.curly = Math.max(0, state.curly - 1);
        i++;
    }
    return state;
};

const isExpressionClosed = (state) => state.paren === 0 && state.curly === 0 && state.square === 0 && !state.longClose;

const canInsertBetween = (line, nextLine, state) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (!isExpressionClosed(state)) return false;
    if (endsWithOpenExpression(trimmed)) return false;
    if (startsBlockBoundary(trimmed)) return false;
    if (startsBlockBoundary(nextLine)) return false;
    if (isTerminatingStatement(trimmed)) return false;
    return true;
};

const makeWatermarkBlock = (options = {}) => {
    const pool = options.digitFree ? DIGIT_FREE_WATERMARKS : WATERMARKS;
    const watermark = pool[randomInt(0, pool.length - 1)];
    const w = randomName();
    const acc = randomName();
    const expected = watermark.length;
    const salt = randomInt(3, 17);

    return [
        'do',
        `local ${w}="${watermark}"`,
        `local ${acc}=#${w}+${num(options, salt)}`,
        `if ${acc}~=${num(options, expected + salt)} then error("SukaRed integrity check failed") end`,
        `if (${acc}<${num(options, 0)}) then print(${w}) end`,
        'end'
    ].join(' ');
};

const makeFingerprintBlock = (fingerprint) => {
    if (!fingerprint) return '';
    const f = randomName();
    const guard = randomName();
    return `do local ${f}="${String(fingerprint).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" local ${guard}=#${f} if ${guard}<0 then print(${f}) end end`;
};

const makeOpaqueBlock = (options = {}) => {
    const a = randomName();
    const b = randomName();
    const i = randomName();
    const n = randomInt(8, 64);
    const m = randomInt(3, 11);
    const mode = randomInt(0, 4);

    if (mode === 0) {
        return `do local ${a}=${num(options, n)} local ${b}=${num(options, 0)} for ${i}=${num(options, 1)},${num(options, m)} do ${b}=(${b}+${i}*${a})%${num(options, 997)} end if (${b}<${num(options, 0)}) then error("SukaRed integrity check failed") end end`;
    }

    if (mode === 1) {
        return `do local ${a}=${num(options, n)} local ${b}=(${a}*${a})-${num(options, n * n)} if (${b}~=${num(options, 0)}) then local function ${randomName()}() return ${b} end;${b}=${b}+${num(options, 1)} end end`;
    }

    if (mode === 2) {
        const pool = options.digitFree ? DIGIT_FREE_WATERMARKS : WATERMARKS;
        const watermark = pool[randomInt(0, pool.length - 1)];
        return `do local ${a}="${watermark}" if (#${a}<${num(options, 0)}) then error(${a}) end end`;
    }

    if (mode === 3) {
        const c = randomName();
        const d = randomName();
        const f = randomName();
        const message = options.digitFree ? 'SukaRed owns you' : 'SukaRed v1.0 owns you';
        return `do local ${a}={} local ${b}=${num(options, n)} local ${c}=#${a}+${num(options, 1)} ${a}[${c}]=function(${d}) return (${d}+${num(options, m)})%${num(options, 997)} end local ${f}=${a}[${c}](${b}) if ${f}<${num(options, 0)} then error("${message}") end end`;
    }

    return `do local ${a}={} local ${b}=${num(options, 0)} repeat ${a}[${b}]=${b}*${b} ${b}=${b}+${num(options, 1)} until ${b}>${num(options, 0)} end`;
};

const injectDeadCode = async (code, options = {}) => {
    const probability = typeof options.probability === 'number' ? options.probability : 0.12;
    const lines = String(code || '').split('\n');
    const output = [];
    const scanState = createScanState();
    let inserted = 0;

    output.push(makeWatermarkBlock(options));
    if (options.fingerprint && !options.digitFree) output.push(makeFingerprintBlock(options.fingerprint));

    for (let index = 0; index < lines.length; index++) {
        output.push(lines[index]);
        scanLine(lines[index], scanState);
        if (inserted < MAX_INSERTIONS && canInsertBetween(lines[index], lines[index + 1], scanState) && Math.random() < probability) {
            output.push(inserted % 3 === 0 ? makeWatermarkBlock(options) : makeOpaqueBlock(options));
            inserted++;
        }
        if (index % 750 === 0) await new Promise(resolve => setImmediate(resolve));
    }

    if (!isTerminatingStatement([...lines].reverse().find(line => line.trim()) || '')) {
        output.push(makeWatermarkBlock(options));
    }
    return output.join('\n');
};

module.exports = {
    injectDeadCode,
    WATERMARKS,
    DIGIT_FREE_WATERMARKS
};
