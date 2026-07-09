const UNICODE_DECOYS = [
    '⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐',
    'アイウエオカキクケコサシスセソタ',
    'अआइईउऊएऐओकखगचजटड',
    '一二三四五六七八九十月火水木金土',
    'ༀ༁༂༃༄༅༆༇༈༉༊་༌།༎༏',
    '※⁂⁑⁜◈◇◆◌◎◉◍◐◑◒◓◔'
];

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_'.split('');

const randomKey = () => Math.floor(Math.random() * 220) + 17;

const shuffle = (items) => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

const luaDecimalString = (value) => `"${[...value].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

const luaSafeString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const encryptBytes = (source, key) => {
    const bytes = Buffer.from(source, 'utf8');
    const out = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        out[i] = (bytes[i] + key + ((i * 13) % 251) + (i % 17)) % 256;
    }
    return out;
};

const encodeCustom64 = (bytes, alphabet) => {
    let acc = 0;
    let bits = 0;
    let out = '';
    for (const byte of bytes) {
        acc = (acc << 8) | byte;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out += alphabet[(acc >> bits) & 63];
        }
    }
    if (bits > 0) {
        out += alphabet[(acc << (6 - bits)) & 63];
    }
    return out;
};

const makeDecoy = () => {
    const chars = shuffle(UNICODE_DECOYS.join('').split(''));
    return chars.slice(0, 48).join('');
};

const rand = (prefix) => `_${prefix}${Math.floor(Math.random() * 90000 + 10000)}`;

const createVmBundle = (source) => {
    const key = randomKey();
    const alphabet = shuffle(BASE64_ALPHABET).join('');
    const encrypted = encryptBytes(source, key);
    const payload = encodeCustom64(encrypted, alphabet);
    const decoyA = makeDecoy();
    const decoyB = makeDecoy();

    const k = {
        string: luaDecimalString('string'),
        table: luaDecimalString('table'),
        math: luaDecimalString('math'),
        byte: luaDecimalString('byte'),
        char: luaDecimalString('char'),
        concat: luaDecimalString('concat'),
        floor: luaDecimalString('floor'),
        loadstring: luaDecimalString('loadstring'),
        debug: luaDecimalString('debug'),
        info: luaDecimalString('info'),
        type: luaDecimalString('type'),
        pcall: luaDecimalString('pcall'),
        error: luaDecimalString('error'),
        tableType: luaDecimalString('table'),
        functionType: luaDecimalString('function'),
        sourceKind: luaDecimalString('s'),
        loadstringError: luaDecimalString('SukaRed VM requires loadstring')
    };

    const v = {
        env: rand('ENV'),
        str: rand('S'),
        tab: rand('T'),
        mat: rand('MATH'),
        typ: rand('TY'),
        pc: rand('PC'),
        err: rand('ER'),
        dbg: rand('DBG'),
        alphabet: rand('A'),
        map: rand('MAP'),
        payload: rand('PAY'),
        out: rand('OUT'),
        acc: rand('ACC'),
        bits: rand('BITS'),
        idx: rand('IDX'),
        i: rand('I'),
        c: rand('C'),
        n: rand('N'),
        b: rand('B'),
        src: rand('SRC'),
        load: rand('LOAD'),
        fn: rand('FN'),
        le: rand('LE'),
        ok: rand('OK'),
        re: rand('RE'),
        decoyA: rand('GL'),
        decoyB: rand('VX')
    };

    const parts = [
        '(function()',
        `local ${v.env}=getfenv()`,
        `local ${v.str}=${v.env}[${k.string}]`,
        `local ${v.tab}=${v.env}[${k.table}]`,
        `local ${v.mat}=${v.env}[${k.math}]`,
        `local ${v.typ}=${v.env}[${k.type}]`,
        `local ${v.pc}=${v.env}[${k.pcall}]`,
        `local ${v.err}=${v.env}[${k.error}]`,
        `local ${v.dbg}=${v.env}[${k.debug}]`,
        `local ${v.decoyA}=${luaSafeString(decoyA)}`,
        `local ${v.decoyB}=${luaSafeString(decoyB)}`,
        `local ${v.alphabet}=${luaSafeString(alphabet)}`,
        `if (not ${v.str}) or (not ${v.tab}) or (not ${v.mat}) or (${v.typ} and ${v.typ}(${v.str})~=${k.tableType}) then while true do end end`,
        `if ${v.dbg} and ${v.dbg}[${k.info}] and ${v.pc} then local _ok=${v.pc}(function()return ${v.dbg}[${k.info}](${v.dbg}[${k.info}],${k.sourceKind})end) if not _ok then while true do end end end`,
        `local ${v.map}={}`,
        `for ${v.i}=1,#${v.alphabet} do ${v.map}[${v.str}[${k.byte}](${v.alphabet},${v.i})]=${v.i}-1 end`,
        `local ${v.payload}=${luaSafeString(payload)}`,
        `local ${v.out}={}`,
        `local ${v.acc}=0`,
        `local ${v.bits}=0`,
        `local ${v.idx}=1`,
        `for ${v.i}=1,#${v.payload} do ${v.c}=${v.map}[${v.str}[${k.byte}](${v.payload},${v.i})] if ${v.c}~=nil then ${v.acc}=${v.acc}*64+${v.c} ${v.bits}=${v.bits}+6 if ${v.bits}>=8 then ${v.bits}=${v.bits}-8 ${v.n}=${v.mat}[${k.floor}](${v.acc}/(2^${v.bits}))%256 ${v.acc}=${v.acc}%(2^${v.bits}) ${v.b}=(${v.n}-${key}-(((${v.idx}-1)*13)%251)-(((${v.idx}-1)%17)))%256 ${v.out}[${v.idx}]=${v.str}[${k.char}](${v.b}) ${v.idx}=${v.idx}+1 end end end`,
        `local ${v.src}=${v.tab}[${k.concat}](${v.out})`,
        `local ${v.load}=${v.env}[${k.loadstring}]`,
        `if (not ${v.load}) or (${v.typ} and ${v.typ}(${v.load})~=${k.functionType}) then if ${v.err} then ${v.err}(${k.loadstringError})else while true do end end end`,
        `local ${v.fn},${v.le}=${v.load}(${v.src})`,
        `if not ${v.fn} then if ${v.err} then ${v.err}(${v.le})else while true do end end end`,
        `local ${v.ok},${v.re}`,
        `if ${v.pc} then ${v.ok},${v.re}=${v.pc}(${v.fn}) else ${v.ok}=true ${v.re}=${v.fn}() end`,
        `if not ${v.ok} then if ${v.err} then ${v.err}(${v.re})else while true do end end end`,
        'end)()'
    ];

    return parts.join(';').replace('(function();', '(function() ').replace(/then;/g, 'then ');
};

module.exports = {
    createVmBundle
};
