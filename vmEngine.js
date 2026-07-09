const randomKey = () => Math.floor(Math.random() * 220) + 17;

const luaDecimalString = (value) => `"${[...value].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

const luaByteString = (bytes) => `"${bytes.map(byte => `\\${String(byte).padStart(3, '0')}`).join('')}"`;

const encodePayloadBytes = (source, key) => {
    const bytes = Buffer.from(source, 'utf8');
    const encoded = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        encoded[i] = (bytes[i] + key + (i % 251)) % 256;
    }
    return encoded;
};

const createVmBundle = (source) => {
    const key = randomKey();
    const payload = luaByteString(encodePayloadBytes(source, key));
    const alphabetSalt = '"⠁⠂⠃⠄⠅⠆⠇⠈アイウエ一二三四"';
    const k = {
        string: luaDecimalString('string'),
        table: luaDecimalString('table'),
        byte: luaDecimalString('byte'),
        char: luaDecimalString('char'),
        concat: luaDecimalString('concat'),
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

    const parts = [
        '(function()',
        'local _E=getfenv()',
        `local _S=_E[${k.string}]`,
        `local _T=_E[${k.table}]`,
        `local _TY=_E[${k.type}]`,
        `local _PC=_E[${k.pcall}]`,
        `local _ER=_E[${k.error}]`,
        `local _D=_E[${k.debug}]`,
        `local _A=${alphabetSalt}`,
        `if(not _S)or(not _T)or(_TY and _TY(_S)~=${k.tableType})then while true do end end`,
        `if _D and _D[${k.info}]then local _ok=_PC(function()return _D[${k.info}](_D[${k.info}],${k.sourceKind})end)if not _ok then while true do end end end`,
        `local _P=${payload}`,
        'local _R={}',
        `for _I=1,#_P do _R[_I]=_S[${k.char}]((_S[${k.byte}](_P,_I)-${key}-((_I-1)%251))%256)end`,
        `local _SRC=_T[${k.concat}](_R)`,
        `local _L=_E[${k.loadstring}]`,
        `if(not _L)or(_TY and _TY(_L)~=${k.functionType})then if _ER then _ER(${k.loadstringError})else while true do end end end`,
        'local _FN,_LE=_L(_SRC)',
        'if not _FN then if _ER then _ER(_LE)else while true do end end end',
        'local _OK,_RE=_PC(_FN)',
        'if not _OK then if _ER then _ER(_RE)else while true do end end end',
        'end)()'
    ];

    return parts.join(';').replace('(function();', '(function() ').replace(/then;/g, 'then ');
};

module.exports = {
    createVmBundle
};
