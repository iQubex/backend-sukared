const randomKey = () => Math.floor(Math.random() * 220) + 17;

const luaDecimalString = (value) => `"${[...value].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

const encodeBytes = (source, key) => {
    const bytes = Buffer.from(source, 'utf8');
    const encoded = [];
    for (const byte of bytes) {
        encoded.push((byte + key) % 256);
    }
    return encoded;
};

const chunkArray = (values, size = 28) => {
    const lines = [];
    for (let i = 0; i < values.length; i += size) {
        lines.push(values.slice(i, i + size).join(','));
    }
    return lines.join(',\n');
};

const createVmBundle = (source) => {
    const key = randomKey();
    const payload = chunkArray(encodeBytes(source, key));
    const k = {
        string: luaDecimalString('string'),
        table: luaDecimalString('table'),
        char: luaDecimalString('char'),
        concat: luaDecimalString('concat'),
        getfenv: luaDecimalString('getfenv'),
        loadstring: luaDecimalString('loadstring'),
        debug: luaDecimalString('debug'),
        info: luaDecimalString('info'),
        type: luaDecimalString('type'),
        pcall: luaDecimalString('pcall'),
        error: luaDecimalString('error')
    };

    return [
        'local __E=getfenv()',
        `local __S=__E[${k.string}]`,
        `local __T=__E[${k.table}]`,
        `local __D=__E[${k.debug}]`,
        `local __TY=__E[${k.type}]`,
        `local __PC=__E[${k.pcall}]`,
        `local __ERR=__E[${k.error}]`,
        `if (not __S) or (not __T) or (__TY and __TY(__S)~=${luaDecimalString('table')}) then while true do end end`,
        `if __D and __D[${k.info}] then local __ok=__PC(function() return __D[${k.info}](__D[${k.info}],${luaDecimalString('s')}) end) if not __ok then while true do end end end`,
        `local __B={${payload}}`,
        `local __R={}`,
        `for __I=1,#__B do __R[__I]=__S[${k.char}]((__B[__I]-${key})%256) end`,
        `local __SRC=__T[${k.concat}](__R)`,
        `local __L=__E[${k.loadstring}]`,
        `if not __L then if __ERR then __ERR(${luaDecimalString('SukaRed VM requires loadstring')}) else while true do end end end`,
        `local __FN,__ER=__L(__SRC)`,
        `if not __FN then if __ERR then __ERR(__ER) else while true do end end end`,
        `return __FN()`
    ].join('\n');
};

module.exports = {
    createVmBundle
};
