const unicodeAlphabet = ['⠁', '⠂', '⠃', '⠄', '⠅', '⠆', '⠇', '⠈', 'ア', 'イ', 'ウ', 'エ', '一', '二', '三', '四'];

const randomKey = () => Math.floor(Math.random() * 254) + 1;

const luaDecimalString = (value) => `"${[...value].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

const encode = (value, key = randomKey()) => {
    let encoded = '';
    for (let i = 0; i < value.length; i++) {
        const encryptedByte = (value.charCodeAt(i) + key) % 256;
        encoded += unicodeAlphabet[Math.floor(encryptedByte / 16)] + unicodeAlphabet[encryptedByte % 16];
    }
    return { encoded, key };
};

const createDecoderCall = (value) => {
    const encrypted = encode(String(value));
    return {
        type: 'CallExpression',
        base: { type: 'Identifier', name: 'lIIll_10O_l' },
        arguments: [
            { type: 'StringLiteral', value: null, raw: `"${encrypted.encoded}"` },
            { type: 'NumericLiteral', value: encrypted.key, raw: String(encrypted.key) }
        ]
    };
};

const createGetfenvLookup = (name) => ({
    type: 'IndexExpression',
    base: {
        type: 'CallExpression',
        base: { type: 'Identifier', name: 'getfenv' },
        arguments: []
    },
    index: createDecoderCall(name)
});

const createDecoderRuntime = () => {
    const stringLookup = luaDecimalString('string');
    const tableLookup = luaDecimalString('table');
    const gmatchLookup = luaDecimalString('gmatch');
    const insertLookup = luaDecimalString('insert');
    const charLookup = luaDecimalString('char');

    return `local function lIIll_10O_l(s,k)
local _S=getfenv()[${stringLookup}]
local _T=getfenv()[${tableLookup}]
local _M={["⠁"]=0,["⠂"]=1,["⠃"]=2,["⠄"]=3,["⠅"]=4,["⠆"]=5,["⠇"]=6,["⠈"]=7,["ア"]=8,["イ"]=9,["ウ"]=10,["エ"]=11,["一"]=12,["二"]=13,["三"]=14,["四"]=15}
local _B={}
local _H=nil
for _C in _S[${gmatchLookup}](s,"([%z\\1-\\127\\194-\\244][\\128-\\191]*)") do
local _V=_M[_C]
if _V~=nil then
if _H==nil then _H=_V else _T[${insertLookup}](_B,_H*16+_V) _H=nil end
end
end
local _R=""
for _I=1,#_B do _R=_R.._S[${charLookup}]((_B[_I]-k)%256) end
return _R
end
`;
};

const attachDecoderRuntime = (code, hasEncryptedStrings) => {
    if (!hasEncryptedStrings) return code;
    return `${createDecoderRuntime()}\n${code}`;
};

module.exports = {
    unicodeAlphabet,
    encode,
    createDecoderCall,
    createGetfenvLookup,
    createDecoderRuntime,
    attachDecoderRuntime,
    luaDecimalString
};
