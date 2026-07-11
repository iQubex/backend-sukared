const MAX_INSERTIONS = 120;

const randomName = () => {
    const chars = ['l', 'I', 'O', '_', '0', '1'];
    let value = '_';
    for (let i = 0; i < 14; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
};

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const canInsertAfter = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/(\bthen|\bdo|\belse|\belseif|\band|\bor|[+\-*/,%^.]|\(|\{|\[)$/.test(trimmed)) return false;
    if (/^(else|elseif|end|until)\b/.test(trimmed)) return false;
    return true;
};

const makeOpaqueBlock = () => {
    const a = randomName();
    const b = randomName();
    const i = randomName();
    const n = randomInt(8, 64);
    const m = randomInt(3, 11);
    const mode = randomInt(0, 2);

    if (mode === 0) {
        return `do local ${a}=${n} local ${b}=0 for ${i}=1,${m} do ${b}=(${b}+${i}*${a})%997 end if (${b}<0) then while true do break end end end`;
    }

    if (mode === 1) {
        return `do local ${a}=${n} local ${b}=(${a}*${a})-${n * n} if (${b}~=0) then local function ${randomName()}() return ${b} end ${b}=${b}+1 end end`;
    }

    return `do local ${a}={} local ${b}=0 while ${b}<0 do ${a}[${b}]=${b}*${b} ${b}=${b}+1 end end`;
};

const injectDeadCode = async (code, options = {}) => {
    const probability = typeof options.probability === 'number' ? options.probability : 0.08;
    const lines = String(code || '').split('\n');
    const output = [];
    let inserted = 0;

    for (let index = 0; index < lines.length; index++) {
        output.push(lines[index]);
        if (inserted < MAX_INSERTIONS && canInsertAfter(lines[index]) && Math.random() < probability) {
            output.push(makeOpaqueBlock());
            inserted++;
        }
        if (index % 750 === 0) await new Promise(resolve => setImmediate(resolve));
    }

    return output.join('\n');
};

module.exports = {
    injectDeadCode
};
