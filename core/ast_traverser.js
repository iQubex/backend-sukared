const luaparse = require('luaparse');
const { parseLuaString } = require('./preprocessor');
const { minifyLuau: minifyLuauSafe } = require('./luau_minifier');
const { selectCipherAlphabet, selectSymbolByteAlphabet } = require('../utils/alphabet_registry');
const { numberExpression } = require('../utils/numeric_encoder');

const YIELD_EVERY_NODES = 1500;
const DECODER_NAME = 'lIIll_IOO_l';
const runtimeNames = new Set(['getfenv', DECODER_NAME]);
const plainWatermarks = new Set([
    'Obfuscated By Sukared',
    'Dont try its very hard',
    'SukaRed 1.0 owns you'
]);

const GLYPH_POOLS = [
    ['⠁', '⠂', '⠃', '⠄', '⠅', '⠆', '⠇', '⠈', '⠉', '⠊', '⠋', '⠌', '⠍', '⠎', '⠏', '⠐'],
    ['ア', 'イ', 'ウ', 'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ', 'ソ', 'タ'],
    ['अ', 'आ', 'इ', 'ई', 'उ', 'ऊ', 'ए', 'ऐ', 'ओ', 'क', 'ख', 'ग', 'च', 'ज', 'ट', 'ड'],
    ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '月', '火', '水', '木', '金', '土'],
    ['ༀ', '༁', '༂', '༃', '༄', '༅', '༆', '༇', '༈', '༉', '༊', '་', '༌', '།', '༎', '༏'],
    ['※', '⁂', '⁑', '⁜', '◈', '◇', '◆', '◌', '◎', '◉', '◍', '◐', '◑', '◒', '◓', '◔']
];

class Scope {
    constructor(parent = null) {
        this.parent = parent;
        this.bindings = Object.create(null);
    }

    define(name, newName) {
        this.bindings[name] = newName;
    }

    lookup(name) {
        let scope = this;
        while (scope) {
            if (Object.prototype.hasOwnProperty.call(scope.bindings, name)) return scope.bindings[name];
            scope = scope.parent;
        }
        return null;
    }
}

const shuffle = (items) => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

const randomName = () => {
    const chars = ['l', 'I', 'O', '_'];
    let value = '_';
    for (let i = 0; i < 18; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
};

const randomHelperName = (prefix = 'D') => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let value = `_SR${prefix}_`;
    for (let i = 0; i < 14; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
};

const choice = (items) => items[Math.floor(Math.random() * items.length)];

const randomDigitFreeSeed = (length = 8) => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
    let value = 'SR';
    for (let i = 0; i < length; i++) value += chars[Math.floor(Math.random() * chars.length)];
    return value;
};

const luaDecimalString = (value) => `"${[...String(value)].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

const luaUtf8String = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const luaRawPatternString = (value) => `"${String(value).replace(/"/g, '\\"')}"`;

const selectFamilyAlphabet = (options) => options.forceAlphabet
    || (options.digitFree ? selectSymbolByteAlphabet(16) : selectCipherAlphabet(16));

const createCipherSession = (options = {}) => {
    const families = options.decoderFamilies && options.decoderFamilies.length ? options.decoderFamilies : ['shift', 'reverseShift', 'bytes'];
    const familyNames = ['shift', 'reverseShift', 'xor', 'stateful', 'bytes', 'closure', 'tableDriven', 'runtimeGenerated'];
    const alphabets = Object.create(null);
    for (const family of familyNames) alphabets[family] = selectFamilyAlphabet(options);
    const decoders = {
        shift: randomHelperName('S'),
        reverseShift: randomHelperName('R'),
        xor: randomHelperName('X'),
        stateful: randomHelperName('T'),
        closure: randomHelperName('C'),
        runtimeGenerated: randomHelperName('G'),
        dispatch: randomHelperName('P'),
        dispatchShiftKey: choice(selectCipherAlphabet(16)),
        dispatchXorKey: choice(selectCipherAlphabet(16))
    };
    const keySeedName = randomHelperName('K');
    const keySeedValue = options.digitFree === true
        ? randomDigitFreeSeed()
        : `SR${Math.random().toString(36).slice(2, 10)}`;
    return {
        alphabets,
        families,
        familyQueue: shuffle(families),
        familyIndex: 0,
        decoders,
        keySeedName,
        keySeedValue,
        digitFree: options.digitFree === true,
        hideNumbers: options.hideNumbers === true || options.digitFree === true,
        inlineStringRate: typeof options.inlineStringRate === 'number' ? options.inlineStringRate : 0.25
    };
};

const nextDecoderFamily = (session) => {
    if (!session.familyQueue.length) return 'shift';
    const family = session.familyQueue[session.familyIndex % session.familyQueue.length];
    session.familyIndex++;
    if (session.familyIndex % session.familyQueue.length === 0) session.familyQueue = shuffle(session.familyQueue);
    return family;
};

const getAlphabet = (session, family) => session.alphabets[family] || session.alphabets.shift;

const alphabetSignature = (alphabet) => alphabet.join('');

const encodeShift = (session, family, value, key, reverse = false) => {
    let encoded = '';
    const alphabet = getAlphabet(session, family);
    const bytes = Buffer.from(String(value), 'utf8');
    for (let i = 0; i < bytes.length; i++) {
        const byte = (bytes[i] + key + (i % 17)) % 256;
        encoded += alphabet[(byte >> 4) & 15] + alphabet[byte & 15];
    }
    return reverse ? [...encoded].reverse().join('') : encoded;
};

const byteXor = (a, b) => {
    let out = 0;
    let bit = 1;
    while (a > 0 || b > 0) {
        const aa = a % 2;
        const bb = b % 2;
        if (aa !== bb) out += bit;
        a = (a - aa) / 2;
        b = (b - bb) / 2;
        bit *= 2;
    }
    return out;
};

const encodeXor = (session, family, value, key) => {
    let encoded = '';
    const alphabet = getAlphabet(session, family);
    const bytes = Buffer.from(String(value), 'utf8');
    for (let i = 0; i < bytes.length; i++) {
        const mask = (key + ((i * 13) % 251)) % 256;
        const byte = byteXor(bytes[i], mask);
        encoded += alphabet[(byte >> 4) & 15] + alphabet[byte & 15];
    }
    return encoded;
};

const encodeStateful = (session, family, value, key) => {
    let encoded = '';
    const alphabet = getAlphabet(session, family);
    let seed = key;
    const bytes = Buffer.from(String(value), 'utf8');
    for (let i = 0; i < bytes.length; i++) {
        const byte = (bytes[i] + seed) % 256;
        encoded += alphabet[(byte >> 4) & 15] + alphabet[byte & 15];
        seed = (seed * 33 + bytes[i] + (i + 1)) % 256;
    }
    return encoded;
};

const numCode = (state, value) => (state.digitFree || state.hideNumbers ? numberExpression(value) : String(value));

const rawExpression = (raw) => ({ type: 'RawExpression', raw });

const createInlineBytesExpression = (state, value, key) => {
    const bytes = Buffer.from(String(value), 'utf8');
    const values = [];
    for (let i = 0; i < bytes.length; i++) values.push(`(${numCode(state, (bytes[i] + key + ((i * 7) % 19)) % 256)}-${numCode(state, key)}-${numCode(state, (i * 7) % 19)})%${numCode(state, 256)}`);
    const s = randomName();
    return rawExpression(`(function() local ${s}=getfenv()[${luaUtf8String('string')}] return ${s}[${luaUtf8String('char')}](${values.join(',')}) end)()`);
};

const keyExpression = (state, key, preferDynamic = false) => {
    const seedLength = state.cipher.keySeedValue.length;
    if (!preferDynamic && Math.random() < 0.45) {
        state.report.staticKeyCount++;
        return numCode(state, key);
    }
    state.report.dynamicKeyCount++;
    const base = Math.max(0, key - seedLength);
    return `(${numCode(state, base)}+#${state.cipher.keySeedName})`;
};

const createDecoderExpression = (state, decoderName, encoded, key, mode = 'direct') => {
    const keyCode = keyExpression(state, key, mode !== 'direct');
    const encodedCode = luaUtf8String(encoded);
    if (mode === 'direct') {
        state.report.directDecoderCallCount++;
        return {
            type: 'CallExpression',
            base: { type: 'Identifier', name: decoderName },
            arguments: [
                { type: 'StringLiteral', value: null, raw: encodedCode },
                { type: 'RawExpression', raw: keyCode }
            ]
        };
    }
    if (mode === 'closure') {
        state.report.indirectDecoderCallCount++;
        return rawExpression(`(function(_F,_S,_K)return _F(_S,_K)end)(${decoderName},${encodedCode},${keyCode})`);
    }
    if (mode === 'nested') {
        state.report.indirectDecoderCallCount++;
        return rawExpression(`(function(_S)return(function(_K)return ${decoderName}(_S,_K)end)(${keyCode})end)(${encodedCode})`);
    }
    state.report.indirectDecoderCallCount++;
    return rawExpression(`({${decoderName}})[${numCode(state, 1)}](${encodedCode},${keyCode})`);
};

const chooseCallMode = (state, family) => {
    if (family === 'shift' && Math.random() < 0.15) return 'direct';
    return choice(['closure', 'nested', 'array']);
};

const createDecoderCall = (state, value) => {
    state.hasEncryptedStrings = true;
    state.report.protectedStringCount++;
    const family = nextDecoderFamily(state.cipher);
    state.report.decoderFamiliesUsed.add(family);
    state.report.dependencyGraphSize += family === 'closure' || family === 'runtimeGenerated' ? 2 : 1;
    const key = Math.floor(Math.random() * 231) + 17;
    if (family === 'bytes') {
        state.report.indirectDecoderCallCount++;
        state.report.dynamicKeyCount++;
        return createInlineBytesExpression(state, value, key);
    }

    if (family === 'closure' && Math.random() < state.cipher.inlineStringRate) {
        state.report.indirectDecoderCallCount++;
        state.report.dynamicKeyCount++;
        return createInlineBytesExpression(state, value, key);
    }

    if (family === 'closure') {
        const encoded = encodeShift(state.cipher, 'closure', value, key, false);
        return createDecoderExpression(state, state.cipher.decoders.closure, encoded, key, choice(['closure', 'nested', 'array']));
    }

    if (family === 'runtimeGenerated') {
        const encoded = encodeXor(state.cipher, 'runtimeGenerated', value, key);
        state.report.indirectDecoderCallCount++;
        return rawExpression(`(function(_E,_D,_K)local _F=_E[${luaUtf8String(state.cipher.decoders.runtimeGenerated)}] return _F(_D,_K)end)({[${luaUtf8String(state.cipher.decoders.runtimeGenerated)}]=${state.cipher.decoders.runtimeGenerated}},${luaUtf8String(encoded)},${keyExpression(state, key, true)})`);
    }

    if (family === 'xor') {
        return createDecoderExpression(state, state.cipher.decoders.xor, encodeXor(state.cipher, 'xor', value, key), key, chooseCallMode(state, family));
    }

    if (family === 'stateful') {
        return createDecoderExpression(state, state.cipher.decoders.stateful, encodeStateful(state.cipher, 'stateful', value, key), key, chooseCallMode(state, family));
    }

    if (family === 'tableDriven') {
        const useXor = Math.random() < 0.5;
        state.report.indirectDecoderCallCount++;
        return {
            type: 'CallExpression',
            base: {
                type: 'IndexExpression',
                base: { type: 'Identifier', name: state.cipher.decoders.dispatch },
                index: { type: 'StringLiteral', value: null, raw: luaUtf8String(useXor ? state.cipher.decoders.dispatchXorKey : state.cipher.decoders.dispatchShiftKey) }
            },
            arguments: [
                { type: 'StringLiteral', value: null, raw: luaUtf8String(useXor ? encodeXor(state.cipher, 'xor', value, key) : encodeShift(state.cipher, 'shift', value, key, false)) },
                { type: 'RawExpression', raw: keyExpression(state, key, true) }
            ]
        };
    }

    const reverse = family === 'reverseShift';
    const decoderName = reverse ? state.cipher.decoders.reverseShift : state.cipher.decoders.shift;
    return createDecoderExpression(state, decoderName, encodeShift(state.cipher, family, value, key, reverse), key, chooseCallMode(state, family));
};

const createGetfenvLookup = (state, name) => ({
    type: 'IndexExpression',
    base: {
        type: 'CallExpression',
        base: { type: 'Identifier', name: 'getfenv' },
        arguments: []
    },
    index: createDecoderCall(state, name)
});

const createDecoderRuntime = (session) => {
    const n = (value) => session.digitFree ? numberExpression(value) : String(value);
    const makeMap = (family, dynamic = false) => {
        const alphabet = getAlphabet(session, family);
        if (!dynamic) return `{${alphabet.map((glyph, index) => `[${luaUtf8String(glyph)}]=${n(index)}`).join(',')}}`;
        const left = alphabet.slice(0, 8);
        const right = alphabet.slice(8);
        const a = randomName();
        const b = randomName();
        const m = randomName();
        const i = randomName();
        const partsA = `{${left.map(luaUtf8String).join(',')}}`;
        const partsB = `{${right.map(luaUtf8String).join(',')}}`;
        return `(function() local ${a}=${partsA};local ${b}=${partsB};local ${m}={};for ${i}=${n(1)},#${a} do ${m}[${a}[${i}]]=${i}-${n(1)} end;for ${i}=${n(1)},#${b} do ${m}[${b}[${i}]]=${i}+${n(7)} end;return ${m} end)()`;
    };
    const stringLookup = session.digitFree ? luaUtf8String('string') : luaDecimalString('string');
    const tableLookup = session.digitFree ? luaUtf8String('table') : luaDecimalString('table');
    const gmatchLookup = session.digitFree ? luaUtf8String('gmatch') : luaDecimalString('gmatch');
    const charLookup = session.digitFree ? luaUtf8String('char') : luaDecimalString('char');
    const concatLookup = session.digitFree ? luaUtf8String('concat') : luaDecimalString('concat');
    const pattern = session.digitFree ? luaUtf8String('.') : luaRawPatternString('([%z\\1-\\127\\194-\\244][\\128-\\191]*)');
    const floorLookup = session.digitFree ? luaUtf8String('floor') : luaDecimalString('floor');
    const mathLookup = session.digitFree ? luaUtf8String('math') : luaDecimalString('math');
    const errorLookup = session.digitFree ? luaUtf8String('error') : luaDecimalString('error');
    const tamperMessage = luaUtf8String('SukaRed decoder range check failed');

    const makeShiftBody = (family, reverse) => [
        `local _S=getfenv()[${stringLookup}]`,
        `local _T=getfenv()[${tableLookup}]`,
        `local _N=getfenv()[${mathLookup}]`,
        `local _E=getfenv()[${errorLookup}]`,
        `local _M=${makeMap(family, family === 'reverseShift')}`,
        'local _O={}',
        'local _H=nil',
        `local _I=${n(1)}`,
        reverse
            ? `local _R={};local _L=${n(1)};for _C in _S[${gmatchLookup}](s,${pattern})do _R[_L]=_C;_L=_L+${n(1)} end;for _P=#_R,${n(1)},-${n(1)} do local _C=_R[_P];local _V=_M[_C];if _V~=nil then if _H==nil then _H=_V else local _B=_H*${n(16)}+_V;local _X=(_B-k-((_I-${n(1)})%${n(17)}))%${n(256)};if _X<${n(0)} or _X>${n(255)} or (_N and _N[${floorLookup}](_X)~=_X)then if _E then _E(${tamperMessage})else while true do end end end;_O[_I]=_S[${charLookup}](_X);_I=_I+${n(1)};_H=nil end end end`
            : `for _C in _S[${gmatchLookup}](s,${pattern})do local _V=_M[_C];if _V~=nil then if _H==nil then _H=_V else local _B=_H*${n(16)}+_V;local _X=(_B-k-((_I-${n(1)})%${n(17)}))%${n(256)};if _X<${n(0)} or _X>${n(255)} or (_N and _N[${floorLookup}](_X)~=_X)then if _E then _E(${tamperMessage})else while true do end end end;_O[_I]=_S[${charLookup}](_X);_I=_I+${n(1)};_H=nil end end end`,
        `return _T[${concatLookup}](_O)`
    ].join(';');

    const makeXorBody = (family) => [
        `local _S=getfenv()[${stringLookup}]`,
        `local _T=getfenv()[${tableLookup}]`,
        `local _N=getfenv()[${mathLookup}]`,
        `local _E=getfenv()[${errorLookup}]`,
        `local _M=${makeMap(family, true)}`,
        `local function _XOR(a,b)local r=${n(0)};local p=${n(1)};while a>${n(0)} or b>${n(0)} do local aa=a%${n(2)};local bb=b%${n(2)};if aa~=bb then r=r+p end;a=(a-aa)/${n(2)};b=(b-bb)/${n(2)};p=p*${n(2)} end;return r end`,
        'local _O={}',
        'local _H=nil',
        `local _I=${n(1)}`,
        `for _C in _S[${gmatchLookup}](s,${pattern})do local _V=_M[_C];if _V~=nil then if _H==nil then _H=_V else local _B=_H*${n(16)}+_V;local _X=_XOR(_B,(k+(((_I-${n(1)})*${n(13)})%${n(251)}))%${n(256)});if _X<${n(0)} or _X>${n(255)} or (_N and _N[${floorLookup}](_X)~=_X)then if _E then _E(${tamperMessage})else while true do end end end;_O[_I]=_S[${charLookup}](_X);_I=_I+${n(1)};_H=nil end end end`,
        `return _T[${concatLookup}](_O)`
    ].join(';');

    const statefulBody = [
        `local _S=getfenv()[${stringLookup}]`,
        `local _T=getfenv()[${tableLookup}]`,
        `local _N=getfenv()[${mathLookup}]`,
        `local _E=getfenv()[${errorLookup}]`,
        `local _M=${makeMap('stateful', false)}`,
        'local _O={}',
        'local _H=nil',
        `local _I=${n(1)}`,
        'local _Z=k',
        `for _C in _S[${gmatchLookup}](s,${pattern})do local _V=_M[_C];if _V~=nil then if _H==nil then _H=_V else local _B=_H*${n(16)}+_V;local _X=(_B-_Z)%${n(256)};if _X<${n(0)} or _X>${n(255)} or (_N and _N[${floorLookup}](_X)~=_X)then if _E then _E(${tamperMessage})else while true do end end end;_O[_I]=_S[${charLookup}](_X);_Z=(_Z*${n(33)}+_X+_I)%${n(256)};_I=_I+${n(1)};_H=nil end end end`,
        `return _T[${concatLookup}](_O)`
    ].join(';');

    const functionHelpers = shuffle([
        `local function ${session.decoders.shift}(s,k) ${makeShiftBody('shift', false)} end`,
        `local function ${session.decoders.reverseShift}(s,k) ${makeShiftBody('reverseShift', true)} end`,
        `local function ${session.decoders.xor}(s,k) ${makeXorBody('xor')} end`,
        `local function ${session.decoders.stateful}(s,k) ${statefulBody} end`
    ]);
    functionHelpers.push(`local function ${session.decoders.closure}(s,k) ${makeShiftBody('closure', false)} end`);
    functionHelpers.push(`local function ${session.decoders.runtimeGenerated}(s,k) ${makeXorBody('runtimeGenerated')} end`);
    functionHelpers.push(`local ${session.decoders.dispatch}={[${luaUtf8String(session.decoders.dispatchShiftKey)}]=${session.decoders.shift},[${luaUtf8String(session.decoders.dispatchXorKey)}]=${session.decoders.xor}}`);
    return functionHelpers.join(';');
};

const createRootScope = () => {
    const scope = new Scope();
    for (const name of runtimeNames) scope.define(name, name);
    return scope;
};

const getErrorContext = (code, err) => {
    const match = String(err && err.message || '').match(/\[(\d+):(\d+)\]/);
    if (!match) return '';
    const lineNo = Number(match[1]);
    const colNo = Number(match[2]);
    const lines = String(code || '').split('\n');
    const start = Math.max(1, lineNo - 2);
    const end = Math.min(lines.length, lineNo + 2);
    const excerpt = [];
    for (let line = start; line <= end; line++) {
        const text = lines[line - 1] || '';
        excerpt.push(`${line}: ${text}`);
        if (line === lineNo) excerpt.push(`${line}: ${' '.repeat(Math.max(0, colNo))}^`);
    }
    return excerpt.join(' | ');
};

const parse = (code, stage = 'parse') => {
    try {
        return luaparse.parse(code, {
            comments: false,
            scope: false,
            luaVersion: '5.2'
        });
    } catch (err) {
        err.stage = stage;
        err.sourceContext = getErrorContext(code, err);
        throw err;
    }
};

const pushArray = (stack, items, scope) => {
    if (!items) return;
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i]) stack.push({ node: items[i], scope });
    }
};

const replaceNode = (target, source) => {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
};

const encryptStringNode = (node, state) => {
    if (node.raw && [...plainWatermarks].some(mark => String(node.raw).includes(mark))) return;
    const value = node.value !== undefined && node.value !== null ? String(node.value) : parseLuaString(node.raw);
    if (value.length === 0) return;
    if (plainWatermarks.has(value)) return;
    replaceNode(node, createDecoderCall(state, value));
};

const transformIdentifier = (node, scope, state) => {
    const resolved = scope.lookup(node.name);
    if (resolved !== null) {
        node.name = resolved;
        return;
    }
    if (runtimeNames.has(node.name)) return;
    replaceNode(node, createGetfenvLookup(state, node.name));
};

const transformMemberExpression = (node, state) => {
    if (!node.identifier || !node.identifier.name) return;
    node.type = 'IndexExpression';
    node.index = createDecoderCall(state, node.identifier.name);
    delete node.identifier;
    delete node.indexer;
};

const transformColonCall = (node, state) => {
    const base = node.base;
    if (!base || base.type !== 'MemberExpression' || base.indexer !== ':' || !base.identifier) return false;
    const methodObject = base.base;
    const selfArgument = JSON.parse(JSON.stringify(methodObject));
    node.arguments = [selfArgument, ...(node.arguments || [])];
    node.base = {
        type: 'IndexExpression',
        base: methodObject,
        index: createDecoderCall(state, base.identifier.name)
    };
    return true;
};

const walkAst = async (root, state) => {
    const stack = [{ node: root, scope: createRootScope() }];
    let processed = 0;

    while (stack.length) {
        const { node, scope } = stack.pop();
        if (!node) continue;
        if (++processed % YIELD_EVERY_NODES === 0) await new Promise(resolve => setImmediate(resolve));

        switch (node.type) {
            case 'Chunk':
                pushArray(stack, node.body, scope);
                break;
            case 'LocalStatement':
                pushArray(stack, node.init, scope);
                for (const id of node.variables || []) {
                    if (id && id.type === 'Identifier') {
                        const renamed = randomName();
                        scope.define(id.name, renamed);
                        id.name = renamed;
                    }
                }
                break;
            case 'AssignmentStatement':
                pushArray(stack, node.init, scope);
                pushArray(stack, node.variables, scope);
                break;
            case 'CallStatement':
                stack.push({ node: node.expression, scope });
                break;
            case 'DoStatement': {
                const child = new Scope(scope);
                pushArray(stack, node.body, child);
                break;
            }
            case 'IfStatement':
                for (let i = (node.clauses || []).length - 1; i >= 0; i--) {
                    const clause = node.clauses[i];
                    const clauseScope = new Scope(scope);
                    pushArray(stack, clause.body, clauseScope);
                    if (clause.condition) stack.push({ node: clause.condition, scope });
                }
                break;
            case 'WhileStatement': {
                const child = new Scope(scope);
                pushArray(stack, node.body, child);
                stack.push({ node: node.condition, scope });
                break;
            }
            case 'RepeatStatement': {
                const child = new Scope(scope);
                stack.push({ node: node.condition, scope: child });
                pushArray(stack, node.body, child);
                break;
            }
            case 'ForNumericStatement': {
                stack.push({ node: node.step, scope });
                stack.push({ node: node.end, scope });
                stack.push({ node: node.start, scope });
                const forScope = new Scope(scope);
                if (node.variable) {
                    const renamed = randomName();
                    forScope.define(node.variable.name, renamed);
                    node.variable.name = renamed;
                }
                pushArray(stack, node.body, forScope);
                break;
            }
            case 'ForGenericStatement': {
                pushArray(stack, node.iterators, scope);
                const forScope = new Scope(scope);
                for (const id of node.variables || []) {
                    if (id && id.type === 'Identifier') {
                        const renamed = randomName();
                        forScope.define(id.name, renamed);
                        id.name = renamed;
                    }
                }
                pushArray(stack, node.body, forScope);
                break;
            }
            case 'ReturnStatement':
                pushArray(stack, node.arguments, scope);
                break;
            case 'FunctionDeclaration': {
                if (node.identifier) {
                    if (node.isLocal && node.identifier.type === 'Identifier') {
                        const renamed = randomName();
                        scope.define(node.identifier.name, renamed);
                        node.identifier.name = renamed;
                    } else {
                        node.implicitSelf = node.identifier.type === 'MemberExpression' && node.identifier.indexer === ':';
                        stack.push({ node: node.identifier, scope });
                    }
                }
                const fnScope = new Scope(scope);
                if (node.implicitSelf) {
                    fnScope.define('self', 'self');
                }
                for (const param of node.parameters || []) {
                    if (param && param.type === 'Identifier') {
                        const renamed = randomName();
                        fnScope.define(param.name, renamed);
                        param.name = renamed;
                    }
                }
                pushArray(stack, node.body, fnScope);
                break;
            }
            case 'Identifier':
                transformIdentifier(node, scope, state);
                break;
            case 'StringLiteral':
                encryptStringNode(node, state);
                break;
            case 'NumericLiteral':
                if ((state.digitFree || state.hideNumbers) && Number.isFinite(Number(node.value))) {
                    node.raw = numberExpression(node.value);
                }
                break;
            case 'TableConstructorExpression':
                pushArray(stack, node.fields, scope);
                break;
            case 'TableKey':
                stack.push({ node: node.value, scope });
                stack.push({ node: node.key, scope });
                break;
            case 'TableKeyString':
                stack.push({ node: node.value, scope });
                if (node.key && node.key.name) {
                    node.type = 'TableKey';
                    node.key = createDecoderCall(state, node.key.name);
                }
                break;
            case 'TableValue':
                stack.push({ node: node.value, scope });
                break;
            case 'BinaryExpression':
            case 'LogicalExpression':
                stack.push({ node: node.right, scope });
                stack.push({ node: node.left, scope });
                break;
            case 'UnaryExpression':
                stack.push({ node: node.argument, scope });
                break;
            case 'MemberExpression':
                stack.push({ node: node.base, scope });
                transformMemberExpression(node, state);
                break;
            case 'IndexExpression':
                stack.push({ node: node.index, scope });
                stack.push({ node: node.base, scope });
                break;
            case 'CallExpression':
                if (!transformColonCall(node, state)) stack.push({ node: node.base, scope });
                else stack.push({ node: node.base.base, scope });
                pushArray(stack, node.arguments, scope);
                break;
            case 'TableCallExpression':
                stack.push({ node: node.arguments, scope });
                stack.push({ node: node.base, scope });
                break;
            case 'StringCallExpression':
                stack.push({ node: node.argument, scope });
                stack.push({ node: node.base, scope });
                break;
        }
    }
};

const joinStatements = (nodes) => (nodes || []).map(astToCode).filter(Boolean).join(';');

const randomStateValue = () => Math.floor(Math.random() * 800000) + 10000;

const canFlattenStatements = (nodes) => Array.isArray(nodes)
    && nodes.length > 2
    && !nodes.some(node => node && ['ReturnStatement', 'BreakStatement', 'FunctionDeclaration'].includes(node.type));

const flattenStatements = (nodes) => {
    const states = nodes.map(() => randomStateValue());
    const exitState = randomStateValue();
    const stateName = randomName();
    const saltName = randomName();
    const saltText = randomDigitFreeSeed(7);
    const saltValue = saltText.length;
    const s = (value) => numberExpression(value);
    const stateExpr = (value) => `(${s(value + saltValue)}-${saltName})`;
    const clauses = nodes.map((node, index) => {
        const next = index === nodes.length - 1 ? exitState : states[index + 1];
        return `${index === 0 ? 'if' : 'elseif'} ${stateName}==${stateExpr(states[index])} then ${astToCode(node)};${stateName}=${stateExpr(next)}`;
    });
    return `do local ${saltName}=#${luaUtf8String(saltText)};local ${stateName}=${stateExpr(states[0])};while true do ${clauses.join(' ')} else break end end end`;
};

const astToCode = (node) => {
    if (!node) return '';
    const baseToCode = (base) => {
        const code = astToCode(base);
        return base && base.type === 'FunctionDeclaration' ? `(${code})` : code;
    };

    switch (node.type) {
        case 'Chunk':
            if (node.flattened && canFlattenStatements(node.body)) return flattenStatements(node.body);
            return joinStatements(node.body);
        case 'LocalStatement': {
            const vars = (node.variables || []).map(astToCode).join(',');
            const inits = (node.init || []).map(astToCode).join(',');
            return inits ? `local ${vars}=${inits}` : `local ${vars}`;
        }
        case 'AssignmentStatement':
            return `${(node.variables || []).map(astToCode).join(',')}=${(node.init || []).map(astToCode).join(',')}`;
        case 'CallStatement':
            return astToCode(node.expression);
        case 'DoStatement':
            return `do ${joinStatements(node.body)} end`;
        case 'IfStatement': {
            let code = '';
            for (const clause of node.clauses || []) {
                if (clause.type === 'IfClause') code += `if ${astToCode(clause.condition)} then ${joinStatements(clause.body)}`;
                else if (clause.type === 'ElseifClause') code += ` elseif ${astToCode(clause.condition)} then ${joinStatements(clause.body)}`;
                else code += ` else ${joinStatements(clause.body)}`;
            }
            return `${code} end`;
        }
        case 'WhileStatement':
            return `while ${astToCode(node.condition)} do ${joinStatements(node.body)} end`;
        case 'RepeatStatement':
            return `repeat ${joinStatements(node.body)} until ${astToCode(node.condition)}`;
        case 'ForNumericStatement': {
            const step = node.step ? `,${astToCode(node.step)}` : '';
            return `for ${astToCode(node.variable)}=${astToCode(node.start)},${astToCode(node.end)}${step} do ${joinStatements(node.body)} end`;
        }
        case 'ForGenericStatement':
            return `for ${(node.variables || []).map(astToCode).join(',')} in ${(node.iterators || []).map(astToCode).join(',')} do ${joinStatements(node.body)} end`;
        case 'ReturnStatement':
            return `return ${(node.arguments || []).map(astToCode).join(',')}`;
        case 'BreakStatement':
            return 'break';
        case 'FunctionDeclaration': {
            const params = (node.parameters || []).map(astToCode);
            const body = joinStatements(node.body);
            if (!node.identifier) return `function(${params.join(',')}) ${body} end`;
            if (node.isLocal) return `local function ${astToCode(node.identifier)}(${params.join(',')}) ${body} end`;
            const fnParams = node.implicitSelf ? ['self', ...params] : params;
            return `${astToCode(node.identifier)}=function(${fnParams.join(',')}) ${body} end`;
        }
        case 'Identifier':
            return node.name;
        case 'RawExpression':
            return node.raw;
        case 'StringLiteral':
            return node.raw || luaUtf8String(String(node.value || ''));
        case 'NumericLiteral':
            return node.raw || String(node.value);
        case 'BooleanLiteral':
            return node.value ? 'true' : 'false';
        case 'NilLiteral':
            return 'nil';
        case 'VarargLiteral':
            return '...';
        case 'TableConstructorExpression':
            return `{${(node.fields || []).map(astToCode).join(',')}}`;
        case 'TableKey':
            return `[${astToCode(node.key)}]=${astToCode(node.value)}`;
        case 'TableKeyString':
            return `${astToCode(node.key)}=${astToCode(node.value)}`;
        case 'TableValue':
            return astToCode(node.value);
        case 'BinaryExpression':
            if (/^(and|or)$/.test(node.operator)) return `(${astToCode(node.left)} ${node.operator} ${astToCode(node.right)})`;
            return `(${astToCode(node.left)}${node.operator}${astToCode(node.right)})`;
        case 'LogicalExpression':
            return `(${astToCode(node.left)} ${node.operator} ${astToCode(node.right)})`;
        case 'UnaryExpression':
            return `(${node.operator === 'not' ? 'not ' : node.operator}${astToCode(node.argument)})`;
        case 'MemberExpression':
            return `${astToCode(node.base)}${node.indexer}${astToCode(node.identifier)}`;
        case 'IndexExpression':
            return `${astToCode(node.base)}[${astToCode(node.index)}]`;
        case 'CallExpression':
            return `${baseToCode(node.base)}(${(node.arguments || []).map(astToCode).join(',')})`;
        case 'TableCallExpression':
            return `${baseToCode(node.base)}${astToCode(node.arguments)}`;
        case 'StringCallExpression':
            return `${baseToCode(node.base)}${astToCode(node.argument)}`;
        default:
            return '';
    }
};

const minifyLuau = (code) => String(code || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([=+\-*/%^#<>{}()[\],;.:])\s*/g, '$1')
    .replace(/\b(and|or)\b/g, ' $1 ')
    .replace(/\bnot\b/g, 'not ')
    .replace(/\s+/g, ' ')
    .trim();

const transformAst = async (code, options = {}) => {
    const state = {
        hasEncryptedStrings: false,
        digitFree: options.digitFree === true,
        hideNumbers: options.hideNumbers === true,
        flattenRate: typeof options.flattenRate === 'number' ? options.flattenRate : 0,
        report: {
            protectedStringCount: 0,
            decoderFamiliesUsed: new Set(),
            helperCount: 0,
            uniqueAstFingerprintCount: 0,
            dependencyGraphSize: 0,
            directDecoderCallCount: 0,
            indirectDecoderCallCount: 0,
            staticKeyCount: 0,
            dynamicKeyCount: 0
        },
        cipher: createCipherSession({
            digitFree: options.digitFree === true,
            hideNumbers: options.hideNumbers === true,
            decoderFamilies: options.decoderFamilies,
            inlineStringRate: options.inlineStringRate,
            forceAlphabet: options.forceAlphabet
        })
    };
    const ast = parse(code, 'ast-input');
    await walkAst(ast, state);
    if (Math.random() < state.flattenRate) ast.flattened = true;
    let output = minifyLuauSafe(astToCode(ast));
    if (state.hasEncryptedStrings) {
        const runtime = createDecoderRuntime(state.cipher);
        state.report.helperCount += 7;
        output = minifyLuauSafe(`do local ${state.cipher.keySeedName}=${luaUtf8String(state.cipher.keySeedValue)};${runtime};${output} end`);
    }
    const decoderFamilies = [...state.report.decoderFamiliesUsed];
    state.report.uniqueAstFingerprintCount = new Set(decoderFamilies.map((name, index) => `${name}:${index % 3}`)).size;
    const usedAlphabetSignatures = decoderFamilies
        .map(family => {
            if (family === 'tableDriven') return 'dispatch:' + alphabetSignature(getAlphabet(state.cipher, 'shift')) + ':' + alphabetSignature(getAlphabet(state.cipher, 'xor'));
            return alphabetSignature(getAlphabet(state.cipher, family));
        });
    const maxAlphabetReuse = usedAlphabetSignatures.reduce((max, signature) => {
        const count = usedAlphabetSignatures.filter(item => item === signature).length;
        return Math.max(max, count);
    }, 0);
    const callTotal = state.report.directDecoderCallCount + state.report.indirectDecoderCallCount;
    const keyTotal = state.report.staticKeyCount + state.report.dynamicKeyCount;
    return {
        code: output,
        hasEncryptedStrings: false,
        report: {
            protectedStringCount: state.report.protectedStringCount,
            decoderFamilyCount: decoderFamilies.length,
            decoderFamilies,
            uniqueAstFingerprintCount: state.report.uniqueAstFingerprintCount,
            helperCount: state.report.helperCount,
            vmFunctionCount: 0,
            dependencyGraphSize: state.report.dependencyGraphSize,
            directDecoderCallRatio: callTotal ? Number((state.report.directDecoderCallCount / callTotal).toFixed(3)) : 0,
            dynamicKeyRatio: keyTotal ? Number((state.report.dynamicKeyCount / keyTotal).toFixed(3)) : 0,
            alphabetReuseRatio: usedAlphabetSignatures.length ? Number((maxAlphabetReuse / usedAlphabetSignatures.length).toFixed(3)) : 0,
            estimatedAnalysisCost: Math.round(
                state.report.protectedStringCount * Math.max(1, decoderFamilies.length) * 1.7
                + state.report.helperCount * 2.5
                + state.report.dependencyGraphSize
            )
        }
    };
};

module.exports = {
    transformAst,
    astToCode,
    parse,
    getErrorContext
};
