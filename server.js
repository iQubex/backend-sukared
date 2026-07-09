const express = require('express');
const cors = require('cors');
const luaparse = require('luaparse');

const app = Web = express();

app.use(cors());
app.use(express.json());

// 1. Görsel Olarak Benzer (Look-alike) İsim Jeneratörü
const generateLookalikeName = () => {
    const startChars = ['l', 'I', 'O', '_'];
    const bodyChars = ['l', 'I', '1', 'O', '0', '_'];
    let len = Math.floor(Math.random() * 8) + 12; // 12-20 karakter arası
    let name = startChars[Math.floor(Math.random() * startChars.length)];
    for (let i = 1; i < len; i++) {
        name += bodyChars[Math.floor(Math.random() * bodyChars.length)];
    }
    return name;
};

// 2. Opaque Predicates (Kör Düğümler) Üreteci
const generateOpaquePredicate = () => {
    const x = Math.floor(Math.random() * 50) + 5;
    const y = Math.floor(Math.random() * 50) + 5;
    
    const rVar = generateLookalikeName;

    const alwaysTrue = [
        `((math.sin(${x}) * math.sin(${x}) + math.cos(${x}) * math.cos(${x})) > 0.999)`,
        `(math.floor(math.pi * ${x}) % 2 == ${Math.floor(Math.PI * x) % 2})`,
        `(#tostring(math.pi) >= 10)`,
        `(math.abs(math.deg(math.asin(1)) - 90) < 0.001)`,
        `(math.sqrt(${x * x}) == ${x})`,
        `(math.max(${x}, ${y}) == ${Math.max(x, y)})`,
        `(math.floor(math.exp(1)) == 2)`,
        `(math.abs(math.log(math.exp(${x})) - ${x}) < 0.0001)`
    ];

    const alwaysFalse = [
        `((math.sin(${x}) * math.sin(${x}) + math.cos(${x}) * math.cos(${x})) < 0.5)`,
        `(math.floor(math.pi * ${x}) % 2 == ${(Math.floor(Math.PI * x) % 2) + 1})`,
        `(#tostring(math.pi) < 5)`,
        `(math.sqrt(${x * x}) < 0)`,
        `(math.ceil(math.log10(100)) == 5)`,
        `(math.abs(math.deg(math.asin(1)) - 90) > 1)`,
        `(math.floor(math.exp(1)) == 3)`
    ];

    const trueCond = alwaysTrue[Math.floor(Math.random() * alwaysTrue.length)];
    const falseCond = alwaysFalse[Math.floor(Math.random() * alwaysFalse.length)];

    const v1 = rVar();
    const v2 = rVar();
    const v3 = rVar();
    const junkBody = `
        local ${v1} = math.sqrt(math.random(100, 500))
        local ${v2} = {}
        for ${v3} = 1, 5 do
            ${v2}[${v3}] = math.sin(${v1} * ${v3}) * math.cos(${v1})
        end
        if ${v2}[1] and ${v2}[1] > 2 then
            ${v1} = ${v1} + 1
        end
    `;

    const type = Math.random() > 0.5 ? 'true' : 'false';
    if (type === 'true') {
        return `
if ${trueCond} then
    local ${rVar()} = math.floor(math.pi)
else
    ${junkBody}
end
`;
    } else {
        return `
if ${falseCond} then
    ${junkBody}
end
`;
    }
};

const insertOpaquePredicates = (code, state) => {
    const lines = code.split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i++) {
        result.push(lines[i]);
        
        const line = lines[i].trim();
        const endsWithContinuation = /[\+\-\*\/,%\.\^]$/.test(line) || 
                                    line.endsWith('and') || 
                                    line.endsWith('or') ||
                                    line.endsWith('then') ||
                                    line.endsWith('do') ||
                                    line.endsWith('else') ||
                                    line.endsWith('elseif');

        if (line.length > 0 && !endsWithContinuation && Math.random() < 0.25) {
            result.push(transformLuaSnippet(generateOpaquePredicate(), state));
        }
    }
    return result.join('\n');
};

// 3. String Kodlama / Şifreleme Metotları (Base16 Unicode Eşlemeli)
const unicodeAlphabet = ['⠁', '⠂', '⠃', '⠄', '⠅', '⠆', '⠇', '⠈', 'ア', 'イ', 'ウ', 'エ', '一', '二', '三', '四'];

const encodeStringToUnicode = (str, key) => {
    let encoded = '';
    for (let i = 0; i < str.length; i++) {
        const encryptedByte = (str.charCodeAt(i) + key) % 256;
        const highNibble = Math.floor(encryptedByte / 16);
        const lowNibble = encryptedByte % 16;
        encoded += unicodeAlphabet[highNibble] + unicodeAlphabet[lowNibble];
    }
    return encoded;
};

const getStringValue = (raw) => {
    if (raw.startsWith('[[') && raw.endsWith(']]')) {
        return raw.substring(2, raw.length - 2);
    }
    const content = raw.substring(1, raw.length - 1);
    return content.replace(/\\(.)/g, (match, char) => {
        if (char === 'n') return '\n';
        if (char === 't') return '\t';
        if (char === 'r') return '\r';
        return char;
    });
};

const createDecryptCall = (name, key = Math.floor(Math.random() * 254) + 1) => ({
    type: 'CallExpression',
    base: {
        type: 'Identifier',
        name: 'lIIll_10O_l'
    },
    arguments: [
        {
            type: 'StringLiteral',
            value: null,
            raw: `"${encodeStringToUnicode(name, key)}"`
        },
        {
            type: 'NumericLiteral',
            value: key,
            raw: String(key)
        }
    ]
});

const luaEscapedStringLiteral = (value) => `"${[...value].map(char => `\\${char.charCodeAt(0)}`).join('')}"`;

// Scope / Kapsam Çözümleyici Sınıfı
class Scope {
    constructor(parent = null) {
        this.parent = parent;
        this.bindings = {};
    }
    define(name, newName) {
        this.bindings[name] = newName;
    }
    lookup(name) {
        if (this.bindings[name] !== undefined) {
            return this.bindings[name];
        }
        if (this.parent) {
            return this.parent.lookup(name);
        }
        return null;
    }
}

const createRuntimeScope = () => {
    const scope = new Scope();
    scope.define('lIIll_10O_l', 'lIIll_10O_l');
    scope.define('lO_10O_lI', 'lO_10O_lI');
    return scope;
};

// 4. StringLiteral, MemberExpression, TableKey ve Identifier Düğümleri Manipülasyonu
const encryptStringNode = (node, state) => {
    const rawVal = node.raw;
    const strVal = getStringValue(rawVal);
    if (strVal.length === 0) return;

    state.hasStrings = true;
    node.type = 'CallExpression';
    const decryptCall = createDecryptCall(strVal);
    node.base = decryptCall.base;
    node.arguments = decryptCall.arguments;
};

const transformToGetfenvLookup = (node, name, state) => {
    state.hasStrings = true;

    node.type = 'IndexExpression';
    node.base = {
        type: 'CallExpression',
        base: {
            type: 'Identifier',
            name: 'getfenv'
        },
        arguments: []
    };
    node.index = createDecryptCall(name);
};

const walk = (node, scope, state) => {
    if (!node) return;

    switch (node.type) {
        case 'Chunk':
            node.body.forEach(stmt => walk(stmt, scope, state));
            break;

        case 'LocalStatement':
            if (node.init) {
                node.init.forEach(expr => walk(expr, scope, state));
            }
            node.variables.forEach(id => {
                const newName = generateLookalikeName();
                scope.define(id.name, newName);
                id.name = newName;
            });
            break;

        case 'AssignmentStatement':
            node.variables.forEach(expr => walk(expr, scope, state));
            node.init.forEach(expr => walk(expr, scope, state));
            break;

        case 'CallStatement':
            walk(node.expression, scope, state);
            break;

        case 'IfStatement':
            node.clauses.forEach(clause => {
                if (clause.condition) {
                    walk(clause.condition, scope, state);
                }
                const clauseScope = new Scope(scope);
                clause.body.forEach(stmt => walk(stmt, clauseScope, state));
            });
            break;

        case 'WhileStatement':
            walk(node.condition, scope, state);
            const whileScope = new Scope(scope);
            node.body.forEach(stmt => walk(stmt, whileScope, state));
            break;

        case 'RepeatStatement':
            const repeatScope = new Scope(scope);
            node.body.forEach(stmt => walk(stmt, repeatScope, state));
            walk(node.condition, repeatScope, state);
            break;

        case 'ForNumericStatement':
            walk(node.start, scope, state);
            walk(node.end, scope, state);
            if (node.step) walk(node.step, scope, state);
            
            const forNumScope = new Scope(scope);
            const loopVarNewName = generateLookalikeName();
            forNumScope.define(node.variable.name, loopVarNewName);
            node.variable.name = loopVarNewName;
            
            node.body.forEach(stmt => walk(stmt, forNumScope, state));
            break;

        case 'ForGenericStatement':
            node.iterators.forEach(expr => walk(expr, scope, state));
            
            const forGenScope = new Scope(scope);
            node.variables.forEach(id => {
                const newName = generateLookalikeName();
                forGenScope.define(id.name, newName);
                id.name = newName;
            });
            
            node.body.forEach(stmt => walk(stmt, forGenScope, state));
            break;

        case 'ReturnStatement':
            node.arguments.forEach(expr => walk(expr, scope, state));
            break;

        case 'BreakStatement':
            break;

        case 'FunctionDeclaration':
            if (!node.identifier) {
                // Anonymous function expression: local f = function(...) ... end
            } else if (node.isLocal) {
                const newName = generateLookalikeName();
                scope.define(node.identifier.name, newName);
                node.identifier.name = newName;
            } else {
                node.implicitSelf = node.identifier.type === 'MemberExpression' && node.identifier.indexer === ':';
                walk(node.identifier, scope, state);
            }
            
            const funcScope = new Scope(scope);
            node.parameters.forEach(param => {
                if (param.type === 'Identifier') {
                    const newName = generateLookalikeName();
                    funcScope.define(param.name, newName);
                    param.name = newName;
                }
            });
            
            node.body.forEach(stmt => walk(stmt, funcScope, state));
            break;

        case 'Identifier': {
            const resolved = scope.lookup(node.name);
            if (resolved !== null) {
                node.name = resolved;
            } else if (node.name !== 'getfenv' && node.name !== 'lIIll_10O_l' && node.name !== 'lO_10O_lI') {
                transformToGetfenvLookup(node, node.name, state);
            }
            break;
        }

        case 'StringLiteral':
            encryptStringNode(node, state);
            break;

        case 'NumericLiteral':
        case 'BooleanLiteral':
        case 'NilLiteral':
        case 'VarargLiteral':
            break;

        case 'TableConstructorExpression':
            node.fields.forEach(field => walk(field, scope, state));
            break;

        case 'TableKey':
            walk(node.key, scope, state);
            walk(node.value, scope, state);
            break;

        case 'TableKeyString': {
            walk(node.value, scope, state);
            
            // Tablo anahtarlarını da şifrele (TableKeyString -> TableKey)
            const keyName = node.key.name;
            state.hasStrings = true;
            
            node.type = 'TableKey';
            node.key = createDecryptCall(keyName);
            break;
        }

        case 'TableValue':
            walk(node.value, scope, state);
            break;

        case 'BinaryExpression':
        case 'LogicalExpression':
            walk(node.left, scope, state);
            walk(node.right, scope, state);
            break;

        case 'UnaryExpression':
            walk(node.argument, scope, state);
            break;

        case 'MemberExpression': {
            walk(node.base, scope, state);
            
            // Özellik/metot isimlerini şifreleyerek IndexExpression'a dönüştür
            const propName = node.identifier.name;
            state.hasStrings = true;
            
            node.type = 'IndexExpression';
            node.index = createDecryptCall(propName);
            break;
        }

        case 'IndexExpression':
            walk(node.base, scope, state);
            walk(node.index, scope, state);
            break;

        case 'CallExpression':
            if (node.base && node.base.type === 'MemberExpression' && node.base.indexer === ':') {
                const methodObj = node.base.base;
                const methodName = node.base.identifier.name;

                // 1. Nesneyi gez
                walk(methodObj, scope, state);
                // 2. Orijinal parametreleri gez (çift gezilmesini engellemek için)
                node.arguments.forEach(arg => walk(arg, scope, state));

                // 3. Gezilmiş nesneyi kopyalayıp parametrelerin en başına (self) ekle
                const selfArg = JSON.parse(JSON.stringify(methodObj));
                node.arguments.unshift(selfArg);

                // 4. Metot ismini şifrele ve taban çağrıyı IndexExpression yap
                state.hasStrings = true;

                node.base = {
                    type: 'IndexExpression',
                    base: methodObj,
                    index: createDecryptCall(methodName)
                };
            } else {
                walk(node.base, scope, state);
                node.arguments.forEach(arg => walk(arg, scope, state));
            }
            break;

        case 'TableCallExpression':
            walk(node.base, scope, state);
            walk(node.arguments, scope, state);
            break;

        case 'StringCallExpression':
            walk(node.base, scope, state);
            walk(node.argument, scope, state);
            break;
    }
};

// 5. AST'den Lua Koduna (String) Geri Dönüşüm Jeneratörü (Düzeltilmiş Boşluk Kuralları ile)
const astToCode = (node) => {
    if (!node) return '';

    const callableBaseToCode = (baseNode) => {
        const code = astToCode(baseNode);
        return baseNode && baseNode.type === 'FunctionDeclaration' ? `(${code})` : code;
    };

    switch (node.type) {
        case 'Chunk':
            return node.body.map(astToCode).join(' ');

        case 'LocalStatement': {
            const vars = node.variables.map(astToCode).join(',');
            if (node.init && node.init.length > 0) {
                const inits = node.init.map(astToCode).join(',');
                return `local ${vars}=${inits}`;
            }
            return `local ${vars}`;
        }

        case 'AssignmentStatement': {
            const vars = node.variables.map(astToCode).join(',');
            const inits = node.init.map(astToCode).join(',');
            return `${vars}=${inits}`;
        }

        case 'CallStatement':
            return astToCode(node.expression);

        case 'IfStatement': {
            let code = '';
            node.clauses.forEach((clause, index) => {
                if (clause.type === 'IfClause') {
                    code += `if ${astToCode(clause.condition)} then ${clause.body.map(astToCode).join(' ')}`;
                } else if (clause.type === 'ElseifClause') {
                    code += ` elseif ${astToCode(clause.condition)} then ${clause.body.map(astToCode).join(' ')}`;
                } else if (clause.type === 'ElseClause') {
                    code += ` else ${clause.body.map(astToCode).join(' ')}`;
                }
            });
            code += ' end';
            return code;
        }

        case 'WhileStatement':
            return `while ${astToCode(node.condition)} do ${node.body.map(astToCode).join(' ')} end`;

        case 'RepeatStatement':
            return `repeat ${node.body.map(astToCode).join(' ')} until ${astToCode(node.condition)}`;

        case 'ForNumericStatement': {
            const stepStr = node.step ? `,${astToCode(node.step)}` : '';
            return `for ${astToCode(node.variable)}=${astToCode(node.start)},${astToCode(node.end)}${stepStr} do ${node.body.map(astToCode).join(' ')} end`;
        }

        case 'ForGenericStatement': {
            const vars = node.variables.map(astToCode).join(',');
            const iters = node.iterators.map(astToCode).join(',');
            return `for ${vars} in ${iters} do ${node.body.map(astToCode).join(' ')} end`;
        }

        case 'ReturnStatement': {
            const args = node.arguments.map(astToCode).join(',');
            return `return ${args}`;
        }

        case 'BreakStatement':
            return 'break';

        case 'FunctionDeclaration': {
            const params = node.parameters.map(astToCode);
            if (!node.identifier) {
                return `function(${params.join(',')}) ${node.body.map(astToCode).join(' ')} end`;
            }
            if (node.isLocal) {
                return `local function ${astToCode(node.identifier)}(${params.join(',')}) ${node.body.map(astToCode).join(' ')} end`;
            }
            const fnParams = node.implicitSelf ? ['self', ...params] : params;
            return `${astToCode(node.identifier)}=function(${fnParams.join(',')}) ${node.body.map(astToCode).join(' ')} end`;
        }

        case 'Identifier':
            return node.name;

        case 'StringLiteral':
            return node.raw;

        case 'NumericLiteral':
            return node.raw;

        case 'BooleanLiteral':
            return node.value ? 'true' : 'false';

        case 'NilLiteral':
            return 'nil';

        case 'VarargLiteral':
            return '...';

        case 'TableConstructorExpression':
            return `{${node.fields.map(astToCode).join(',')}}`;

        case 'TableKey':
            return `[${astToCode(node.key)}]=${astToCode(node.value)}`;

        case 'TableKeyString':
            return `${astToCode(node.key)}=${astToCode(node.value)}`;

        case 'TableValue':
            return astToCode(node.value);

        case 'BinaryExpression':
            if (/^(and|or)$/.test(node.operator)) {
                return `(${astToCode(node.left)} ${node.operator} ${astToCode(node.right)})`;
            }
            return `(${astToCode(node.left)}${node.operator}${astToCode(node.right)})`;

        case 'LogicalExpression':
            // Mantıksal operatörlerin (and, or) etrafında boşluk bırakılmasını sağla
            return `(${astToCode(node.left)} ${node.operator} ${astToCode(node.right)})`;

        case 'UnaryExpression':
            // "not" operatörünün etrafında boşluk bırakılmasını sağla
            return `(${node.operator === 'not' ? 'not ' : node.operator}${astToCode(node.argument)})`;

        case 'MemberExpression':
            return `${astToCode(node.base)}${node.indexer}${astToCode(node.identifier)}`;

        case 'IndexExpression':
            return `${astToCode(node.base)}[${astToCode(node.index)}]`;

        case 'CallExpression':
            return `${callableBaseToCode(node.base)}(${node.arguments.map(astToCode).join(',')})`;

        case 'TableCallExpression':
            return `${callableBaseToCode(node.base)}${astToCode(node.arguments)}`;

        case 'StringCallExpression':
            return `${callableBaseToCode(node.base)}${astToCode(node.argument)}`;

        default:
            return '';
    }
};

const transformLuaSnippet = (code, state) => {
    const ast = luaparse.parse(code, { comments: false });
    walk(ast, createRuntimeScope(), state);
    return astToCode(ast);
};

const createDecryptRuntime = () => {
    const stringLookup = luaEscapedStringLiteral('string');
    const tableLookup = luaEscapedStringLiteral('table');
    const gmatchLookup = luaEscapedStringLiteral('gmatch');
    const insertLookup = luaEscapedStringLiteral('insert');
    const charLookup = luaEscapedStringLiteral('char');

    return `local function lIIll_10O_l(s,k)local lS=getfenv()[${stringLookup}]local lT=getfenv()[${tableLookup}]local lI_m={["⠁"]=0,["⠂"]=1,["⠃"]=2,["⠄"]=3,["⠅"]=4,["⠆"]=5,["⠇"]=6,["⠈"]=7,["ア"]=8,["イ"]=9,["ウ"]=10,["エ"]=11,["一"]=12,["二"]=13,["三"]=14,["四"]=15}local lI_b={}local lI_t=nil for lI_c in lS[${gmatchLookup}](s,"([%z\\1-\\127\\194-\\244][\\128-\\191]*)")do local lI_v=lI_m[lI_c]if lI_v then if not lI_t then lI_t=lI_v else lT[${insertLookup}](lI_b,lI_t*16+lI_v)lI_t=nil end end end local lI_r=""for lI_i=1,#lI_b do lI_r=lI_r..lS[${charLookup}]((lI_b[lI_i]-k)%256)end return lI_r end `;
};

const minifyLuau = (code) => {
    return code.replace(/\s+/g, ' ').trim();
};

app.post('/obfuscate', (req, res) => {
    let code = req.body.code;
    if (!code) return res.status(400).send({ error: "Kod gönder kanka!" });

    try {
        // Yorum satırlarını temizleme
        let cleanedCode = code
            .replace(/--\[\[[\s\S]*?\]\]/g, '')
            .replace(/--.*$/gm, '');

        // 1. Aşama: Lua AST Parsing
        const ast = luaparse.parse(cleanedCode, { comments: false });

        // Global scope oluştur (decrypt ve anti-tamper fonksiyon adlarını koru)
        const globalScope = createRuntimeScope();

        // State nesnesi
        const state = { hasStrings: false };

        // 2. Aşama: AST Gezme, getfenv Dönüşümü, Member Hiding ve Değişken İsim Bozma
        walk(ast, globalScope, state);

        // 3. Aşama: AST'den Lua Koduna Geri Dönüş
        let obfCode = astToCode(ast);

        // 4. Aşama: Anti-Tamper Header Enjeksiyonu
        const antiTamper = `local function lO_10O_lI() if not debug or type(debug) ~= "table" or not debug.info then while true do end end if debug.info(debug.info, "s") ~= "[C]" then while true do end end local function lI_dummy() end if debug.info(lI_dummy, "s") == "[C]" then while true do end end local lI_list = {string.char, pcall, xpcall, unpack, setmetatable} if getfenv then table.insert(lI_list, getfenv) end for lI_i = 1, #lI_list do if type(lI_list[lI_i]) ~= "function" or debug.info(lI_list[lI_i], "s") ~= "[C]" then while true do end end end end lO_10O_lI() `;
        obfCode = transformLuaSnippet(antiTamper, state) + obfCode;

        // 5. Aşama: Opaque Predicates (Kör Düğümler) Ekleme
        obfCode = insertOpaquePredicates(obfCode, state);

        // 6. Aşama: Şifre Çözücü Enjeksiyonu
        if (state.hasStrings) {
            obfCode = createDecryptRuntime() + obfCode;
        }

        // 7. Aşama: Minification
        obfCode = minifyLuau(obfCode);

        res.json({
            status: "success",
            original_length: code.length,
            obfuscated: obfCode
        });
    } catch (err) {
        res.status(500).json({ error: "Obfuscation sırasında bir hata oluştu: " + err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Obfuscator API ${PORT} portunda ayakta!`));
