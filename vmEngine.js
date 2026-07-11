const { minifyLuau } = require('./core/luau_minifier');
const { makeDecoyAlphabet, selectVmAlphabet, shuffle } = require('./utils/alphabet_registry');

const randomKey = () => Math.floor(Math.random() * 220) + 17;

const luaDecimalString = (value) => `"${[...String(value)].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

const luaSafeString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const rand = (prefix) => `_${prefix}${Math.floor(Math.random() * 900000 + 100000)}`;

const checksum = (bytes) => {
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * (i + 7)) % 2147483647;
    return sum;
};

const encryptBytes = (source, key, salt) => {
    const bytes = Buffer.from(source, 'utf8');
    const out = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        const stream = (key + ((i * 13) % 251) + ((i + salt) % 29) + ((i * salt) % 17)) % 256;
        out[i] = (bytes[i] + stream) % 256;
    }
    return out;
};

const encodeCustom64 = (bytes, alphabet) => {
    const glyphs = [...alphabet];
    let acc = 0;
    let bits = 0;
    let out = '';
    for (const byte of bytes) {
        acc = (acc << 8) | byte;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out += glyphs[(acc >> bits) & 63];
        }
    }
    if (bits > 0) out += glyphs[(acc << (6 - bits)) & 63];
    return out;
};

const createLookupKeys = () => ({
    string: luaDecimalString('string'),
    table: luaDecimalString('table'),
    math: luaDecimalString('math'),
    gmatch: luaDecimalString('gmatch'),
    byte: luaDecimalString('byte'),
    char: luaDecimalString('char'),
    concat: luaDecimalString('concat'),
    floor: luaDecimalString('floor'),
    loadstring: luaDecimalString('loadstring'),
    type: luaDecimalString('type'),
    pcall: luaDecimalString('pcall'),
    error: luaDecimalString('error'),
    tableType: luaDecimalString('table'),
    functionType: luaDecimalString('function'),
    loadstringError: luaDecimalString('SukaRed VM requires loadstring'),
    utf8Pattern: luaDecimalString('([%z\\1-\\127\\194-\\244][\\128-\\191]*)')
});

const createVmBundle = (source) => {
    const key = randomKey();
    const salt = Math.floor(Math.random() * 97) + 31;
    const alphabet = selectVmAlphabet(64);
    const encrypted = encryptBytes(source, key, salt);
    const payload = encodeCustom64(encrypted, alphabet);
    const integrity = checksum(encrypted);
    const decoyA = makeDecoyAlphabet(48);
    const decoyB = shuffle([...alphabet]).join('');
    const k = createLookupKeys();

    const v = {
        env: rand('E'), str: rand('S'), tab: rand('T'), mat: rand('M'), typ: rand('Y'),
        pc: rand('P'), err: rand('R'), alphabet: rand('A'), map: rand('N'), payload: rand('L'),
        out: rand('O'), acc: rand('C'), bits: rand('B'), idx: rand('I'), glyph: rand('G'),
        val: rand('V'), i: rand('J'), n: rand('Q'), b: rand('X'), src: rand('Z'),
        load: rand('D'), fn: rand('F'), le: rand('H'), ok: rand('K'), re: rand('W'),
        sum: rand('U'), decoyA: rand('DA'), decoyB: rand('DB')
    };

    const mapEntries = [...alphabet].map((glyph, index) => `[${luaSafeString(glyph)}]=${index}`).join(',');
    const parts = [
        '(function()',
        `local ${v.env}=getfenv()`,
        `local ${v.str}=${v.env}[${k.string}]`,
        `local ${v.tab}=${v.env}[${k.table}]`,
        `local ${v.mat}=${v.env}[${k.math}]`,
        `local ${v.typ}=${v.env}[${k.type}]`,
        `local ${v.pc}=${v.env}[${k.pcall}]`,
        `local ${v.err}=${v.env}[${k.error}]`,
        `local ${v.decoyA}=${luaSafeString(decoyA)}`,
        `local ${v.decoyB}=${luaSafeString(decoyB)}`,
        `local ${v.alphabet}=${luaSafeString(alphabet)}`,
        `if(not ${v.str})or(not ${v.tab})or(not ${v.mat})or(${v.typ} and ${v.typ}(${v.str})~=${k.tableType})then while true do end end`,
        `local ${v.map}={${mapEntries}}`,
        `local ${v.payload}=${luaSafeString(payload)}`,
        `local ${v.out}={}`,
        `local ${v.acc}=0`,
        `local ${v.bits}=0`,
        `local ${v.idx}=1`,
        `local ${v.sum}=0`,
        `for ${v.glyph} in ${v.str}[${k.gmatch}](${v.payload},${k.utf8Pattern})do ${v.val}=${v.map}[${v.glyph}];if ${v.val}~=nil then ${v.acc}=${v.acc}*64+${v.val};${v.bits}=${v.bits}+6;if ${v.bits}>=8 then ${v.bits}=${v.bits}-8;${v.n}=${v.mat}[${k.floor}](${v.acc}/(2^${v.bits}))%256;${v.acc}=${v.acc}%(2^${v.bits});${v.sum}=(${v.sum}+${v.n}*(${v.idx}+6))%2147483647;${v.b}=(${v.n}-((${key}+(((${v.idx}-1)*13)%251)+(((${v.idx}-1)+${salt})%29)+((((${v.idx}-1)*${salt})%17)))%256))%256;${v.out}[${v.idx}]=${v.str}[${k.char}](${v.b});${v.idx}=${v.idx}+1 end end end`,
        `if ${v.sum}~=${integrity} then while true do end end`,
        `local ${v.src}=${v.tab}[${k.concat}](${v.out})`,
        `local ${v.load}=${v.env}[${k.loadstring}]`,
        `if(not ${v.load})or(${v.typ} and ${v.typ}(${v.load})~=${k.functionType})then if ${v.err} then ${v.err}(${k.loadstringError})else while true do end end end`,
        `local ${v.fn},${v.le}=${v.load}(${v.src})`,
        `if not ${v.fn} then if ${v.err} then ${v.err}(${v.le})else while true do end end end`,
        `local ${v.ok},${v.re}`,
        `if ${v.pc} then ${v.ok},${v.re}=${v.pc}(${v.fn})else ${v.ok}=true;${v.re}=${v.fn}()end`,
        `if not ${v.ok} then if ${v.err} then ${v.err}(${v.re})else while true do end end end`,
        'end)()'
    ];

    return minifyLuau(parts.join(';')).replace('(function();', '(function()');
};

module.exports = {
    createVmBundle
};
