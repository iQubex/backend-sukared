const GLYPH_POOLS = [
    ['⠁', '⠂', '⠃', '⠄', '⠅', '⠆', '⠇', '⠈', '⠉', '⠊', '⠋', '⠌', '⠍', '⠎', '⠏', '⠐'],
    ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ', 'タ'],
    ['अ', 'आ', 'इ', 'ई', 'उ', 'ऊ', 'ए', 'ऐ', 'ओ', 'क', 'ख', 'ग', 'च', 'ज', 'ट', 'ड'],
    ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '月', '火', '水', '木', '金', '土'],
    ['ༀ', '༁', '༂', '༃', '༄', '༅', '༆', '༇', '༈', '༉', '༊', '་', '༌', '།', '༎', '༏'],
    ['※', '⁂', '⁑', '⁜', '◈', '◇', '◆', '◌', '◎', '◉', '◍', '◐', '◑', '◒', '◓', '◔']
];

const randomKey = () => Math.floor(Math.random() * 220) + 17;

const shuffle = (items) => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

const pickAlphabet = () => {
    const pool = GLYPH_POOLS[Math.floor(Math.random() * GLYPH_POOLS.length)];
    return shuffle(pool).slice(0, 16);
};

const luaDecimalString = (value) => `"${[...value].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

const luaUtf8String = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const encodePayloadGlyphs = (source, key, alphabet) => {
    const bytes = Buffer.from(source, 'utf8');
    let encoded = '';
    for (let i = 0; i < bytes.length; i++) {
        const mixed = (bytes[i] + key + ((i * 7) % 251) + (i % 13)) % 256;
        encoded += alphabet[(mixed >> 4) & 15] + alphabet[mixed & 15];
    }
    return encoded;
};

const createMapLiteral = (alphabet) => {
    return `{${alphabet.map((glyph, index) => `[${luaUtf8String(glyph)}]=${index}`).join(',')}}`;
};

const createDecoyAlphabet = () => luaUtf8String(shuffle(GLYPH_POOLS.flat()).slice(0, 32).join(''));

const createVmBundle = (source) => {
    const key = randomKey();
    const alphabet = pickAlphabet();
    const payload = luaUtf8String(encodePayloadGlyphs(source, key, alphabet));
    const map = createMapLiteral(alphabet);
    const k = {
        string: luaDecimalString('string'),
        table: luaDecimalString('table'),
        char: luaDecimalString('char'),
        concat: luaDecimalString('concat'),
        gmatch: luaDecimalString('gmatch'),
        loadstring: luaDecimalString('loadstring'),
        debug: luaDecimalString('debug'),
        info: luaDecimalString('info'),
        type: luaDecimalString('type'),
        pcall: luaDecimalString('pcall'),
        error: luaDecimalString('error'),
        tableType: luaDecimalString('table'),
        functionType: luaDecimalString('function'),
        sourceKind: luaDecimalString('s'),
        utf8Pattern: luaDecimalString('([%z\\1-\\127\\194-\\244][\\128-\\191]*)'),
        loadstringError: luaDecimalString('SukaRed VM requires loadstring')
    };

    const v = {
        env: '_ENV' + Math.floor(Math.random() * 9999),
        str: '_S' + Math.floor(Math.random() * 9999),
        tab: '_T' + Math.floor(Math.random() * 9999),
        typ: '_Y' + Math.floor(Math.random() * 9999),
        pc: '_P' + Math.floor(Math.random() * 9999),
        err: '_R' + Math.floor(Math.random() * 9999),
        dbg: '_D' + Math.floor(Math.random() * 9999),
        map: '_M' + Math.floor(Math.random() * 9999),
        pay: '_Q' + Math.floor(Math.random() * 9999),
        out: '_O' + Math.floor(Math.random() * 9999),
        hi: '_H' + Math.floor(Math.random() * 9999),
        idx: '_I' + Math.floor(Math.random() * 9999),
        ch: '_C' + Math.floor(Math.random() * 9999),
        val: '_V' + Math.floor(Math.random() * 9999),
        src: '_X' + Math.floor(Math.random() * 9999),
        load: '_L' + Math.floor(Math.random() * 9999),
        fn: '_F' + Math.floor(Math.random() * 9999),
        le: '_E' + Math.floor(Math.random() * 9999),
        ok: '_K' + Math.floor(Math.random() * 9999),
        re: '_N' + Math.floor(Math.random() * 9999),
        salt: '_Z' + Math.floor(Math.random() * 9999)
    };

    const parts = [
        '(function()',
        `local ${v.env}=getfenv()`,
        `local ${v.str}=${v.env}[${k.string}]`,
        `local ${v.tab}=${v.env}[${k.table}]`,
        `local ${v.typ}=${v.env}[${k.type}]`,
        `local ${v.pc}=${v.env}[${k.pcall}]`,
        `local ${v.err}=${v.env}[${k.error}]`,
        `local ${v.dbg}=${v.env}[${k.debug}]`,
        `local ${v.salt}=${createDecoyAlphabet()}`,
        `if(not ${v.str})or(not ${v.tab})or(${v.typ} and ${v.typ}(${v.str})~=${k.tableType})then while true do end end`,
        `if ${v.dbg} and ${v.dbg}[${k.info}]then local _ok=${v.pc}(function()return ${v.dbg}[${k.info}](${v.dbg}[${k.info}],${k.sourceKind})end)if not _ok then while true do end end end`,
        `local ${v.map}=${map}`,
        `local ${v.pay}=${payload}`,
        `local ${v.out}={}`,
        `local ${v.hi}=nil`,
        `local ${v.idx}=1`,
        `for ${v.ch} in ${v.str}[${k.gmatch}](${v.pay},${k.utf8Pattern})do local ${v.val}=${v.map}[${v.ch}] if ${v.val}~=nil then if ${v.hi}==nil then ${v.hi}=${v.val} else local _B=${v.hi}*16+${v.val} ${v.out}[${v.idx}]=${v.str}[${k.char}]((_B-${key}-(((${v.idx}-1)*7)%251)-(((${v.idx}-1)%13)))%256) ${v.idx}=${v.idx}+1 ${v.hi}=nil end end end`,
        `local ${v.src}=${v.tab}[${k.concat}](${v.out})`,
        `local ${v.load}=${v.env}[${k.loadstring}]`,
        `if(not ${v.load})or(${v.typ} and ${v.typ}(${v.load})~=${k.functionType})then if ${v.err} then ${v.err}(${k.loadstringError})else while true do end end end`,
        `local ${v.fn},${v.le}=${v.load}(${v.src})`,
        `if not ${v.fn} then if ${v.err} then ${v.err}(${v.le})else while true do end end end`,
        `local ${v.ok},${v.re}=${v.pc}(${v.fn})`,
        `if not ${v.ok} then if ${v.err} then ${v.err}(${v.re})else while true do end end end`,
        'end)()'
    ];

    return parts.join(';').replace('(function();', '(function() ').replace(/then;/g, 'then ');
};

module.exports = {
    createVmBundle
};
