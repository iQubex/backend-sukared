const express = require('express');
const cors = require('cors'); // 1. EKLENEN SATIR: Kütüphaneyi çağırdık

const app = express();

app.use(cors()); // 2. EKLENEN SATIR: Tarayıcı engellerini kaldırdık
app.use(express.json());

// Opaque Predicates (Kör Düğümler) Üreteci
const generateOpaquePredicate = () => {
    const x = Math.floor(Math.random() * 50) + 5;
    const y = Math.floor(Math.random() * 50) + 5;
    
    const rVar = () => 'lI' + Math.random().toString(36).substring(7).replace(/[0-9]/g, 'I') + Math.floor(Math.random() * 100);

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

const insertOpaquePredicates = (code) => {
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
            result.push(generateOpaquePredicate());
        }
    }
    return result.join('\n');
};

// String Şifreleme ve Decode Fonksiyonu Ekleme
const encryptStringsAndAddDecrypt = (code) => {
    // Yorum satırlarını temizleme
    let cleanedCode = code
        .replace(/--\[\[[\s\S]*?\]\]/g, '')
        .replace(/--.*$/gm, '');

    // String ifadeleri yakalayan regex (escaped tırnak işaretlerini de destekler)
    const stringRegex = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
    
    let hasStrings = false;
    let obfCode = cleanedCode.replace(stringRegex, (match, p1, p2) => {
        const str = p1 !== undefined ? p1 : p2;
        if (str.length === 0) return match;
        
        hasStrings = true;
        const key = Math.floor(Math.random() * 254) + 1;
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            bytes.push((str.charCodeAt(i) + key) % 256);
        }
        return `_DECRYPT({${bytes.join(',')}},${key})`;
    });

    if (hasStrings) {
        // Luau için sıkıştırılmış decode fonksiyonu
        const decryptFn = `local function _DECRYPT(t,k)local s=""for i=1,#t do s=s..string.char((t[i]-k)%256)end return s end `;
        obfCode = decryptFn + obfCode;
    }
    return obfCode;
};

// Unicode Değişken İsimleri (Braille, Katakana, Çince, Zero-Width) Üreteci
const unicodePool = [
    ...'⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟',
    ...'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
    ...'一二三四五六七八九十百千万大小上下左右月火水木金土',
    '\u200B', '\u200C', '\u200D'
];

const generateUnicodeName = () => {
    let len = Math.floor(Math.random() * 5) + 5;
    let name = '';
    const startPool = unicodePool.filter(c => c !== '\u200B' && c !== '\u200C' && c !== '\u200D');
    name += startPool[Math.floor(Math.random() * startPool.length)];
    for (let i = 1; i < len; i++) {
        name += unicodePool[Math.floor(Math.random() * unicodePool.length)];
    }
    return name;
};

const renameVariables = (code) => {
    const varSet = new Set();
    
    const localFuncRegex = /local\s+function\s+([a-zA-Z_]\w*)/g;
    let match;
    while ((match = localFuncRegex.exec(code)) !== null) {
        varSet.add(match[1]);
    }
    
    const funcRegex = /function\s+([a-zA-Z_]\w*)/g;
    while ((match = funcRegex.exec(code)) !== null) {
        varSet.add(match[1]);
    }

    const localValRegex = /local\s+([a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*)/g;
    while ((match = localValRegex.exec(code)) !== null) {
        const vars = match[1].split(',').map(v => v.trim());
        vars.forEach(v => {
            if (v) varSet.add(v);
        });
    }

    const paramRegex = /function\s+[a-zA-Z_]\w*\s*\(([^)]*)\)/g;
    while ((match = paramRegex.exec(code)) !== null) {
        const params = match[1].split(',').map(p => p.trim());
        params.forEach(p => {
            if (p && p !== '...') varSet.add(p);
        });
    }

    if (code.includes('_DECRYPT')) {
        varSet.add('_DECRYPT');
    }

    const keywords = new Set([
        'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
        'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
        'true', 'until', 'while', 'math', 'string', 'table', 'print', 'pairs',
        'ipairs', 'tostring', 'tonumber', 'next', 'select', 'warn', 'error'
    ]);
    
    const varsToRename = Array.from(varSet).filter(v => !keywords.has(v));

    varsToRename.sort((a, b) => b.length - a.length);

    const renameMap = {};
    const usedNames = new Set();

    varsToRename.forEach(v => {
        let uName = generateUnicodeName();
        while (usedNames.has(uName)) {
            uName = generateUnicodeName();
        }
        usedNames.add(uName);
        renameMap[v] = uName;
    });

    let obfCode = code;
    varsToRename.forEach(v => {
        const reg = new RegExp('\\b' + v + '\\b', 'g');
        obfCode = obfCode.replace(reg, renameMap[v]);
    });

    return obfCode;
};

// Kodları Tek Satırda Birleştirme
const minifyLuau = (code) => {
    return code.replace(/\s+/g, ' ').trim();
};

app.post('/obfuscate', (req, res) => {
    let code = req.body.code;
    if (!code) return res.status(400).send({ error: "Kod gönder kanka!" });

    try {
        // 1. Aşama: Yorum Satırlarını Sil, Stringleri Şifrele ve Decode Fonksiyonu Ekle
        let obfCode = encryptStringsAndAddDecrypt(code);

        // 2. Aşama: Opaque Predicates (Kör Düğümler) Ekleme
        obfCode = insertOpaquePredicates(obfCode);

        // 3. Aşama: Değişken ve Fonksiyon İsimlerini Unicode Karakterlerle Değiştir
        obfCode = renameVariables(obfCode);

        // 4. Aşama: Kodları Sıkıştır ve Birleştir (Tek Satır/Düzen Gözetmeksizin)
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