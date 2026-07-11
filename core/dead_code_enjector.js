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
    const chars = ['l', 'I', 'O', '_', '0', '1'];
    let value = '_';
    for (let i = 0; i < 16; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
};

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const checksum = (value) => {
    let sum = 0;
    for (let i = 0; i < value.length; i++) sum = (sum + value.charCodeAt(i) * (i + 3)) % 65535;
    return sum;
};

const startsBlockBoundary = (line) => /^(else|elseif|end|until)\b/.test(String(line || '').trim());

const endsWithOpenExpression = (line) => /(\bthen|\bdo|\belse|\belseif|\band|\bor|[+\-*/,%^.]|\(|\{|\[)$/.test(line);

const isTerminatingStatement = (line) => /^(return|break|continue)\b/.test(String(line || '').trim());

const canInsertBetween = (line, nextLine) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
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
    const i = randomName();
    const expected = checksum(watermark);

    return [
        'do',
        `local ${w}="${watermark}"`,
        `local ${acc}=0`,
        `for ${i}=1,#${w} do ${acc}=(${acc}+string.byte(${w},${i})*(${i}+2))%65535 end`,
        `if ${acc}~=${expected} then while true do end end`,
        `if (${acc}<0) then print(${w}) end`,
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
    const mode = randomInt(0, 3);

    if (mode === 0) {
        return `do local ${a}=${n} local ${b}=0 for ${i}=1,${m} do ${b}=(${b}+${i}*${a})%997 end if (${b}<0) then while true do break end end end`;
    }

    if (mode === 1) {
        return `do local ${a}=${n} local ${b}=(${a}*${a})-${n * n} if (${b}~=0) then local function ${randomName()}() return ${b} end;${b}=${b}+1 end end`;
    }

    if (mode === 2) {
        const pool = options.digitFree ? DIGIT_FREE_WATERMARKS : WATERMARKS;
        const watermark = pool[randomInt(0, pool.length - 1)];
        return `do local ${a}="${watermark}" if (#${a}<0) then error(${a}) end end`;
    }

    return `do local ${a}={} local ${b}=0 while ${b}<0 do ${a}[${b}]=${b}*${b} ${b}=${b}+1 end end`;
};

const injectDeadCode = async (code, options = {}) => {
    const probability = typeof options.probability === 'number' ? options.probability : 0.12;
    const lines = String(code || '').split('\n');
    const output = [];
    let inserted = 0;

    output.push(makeWatermarkBlock(options));
    if (options.fingerprint && !options.digitFree) output.push(makeFingerprintBlock(options.fingerprint));

    for (let index = 0; index < lines.length; index++) {
        output.push(lines[index]);
        if (inserted < MAX_INSERTIONS && canInsertBetween(lines[index], lines[index + 1]) && Math.random() < probability) {
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
