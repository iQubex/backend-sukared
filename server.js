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

app.post('/obfuscate', (req, res) => {
    let code = req.body.code;
    if (!code) return res.status(400).send({ error: "Kod gönder kanka!" });

    // 1. Aşama: String Şifreleme (Metinleri ASCII sayılarına çevirir)
    let obfCode = code.replace(/"(.*?)"/g, (match, p1) => {
        let bytes = [];
        for (let i = 0; i < p1.length; i++) {
            bytes.push(p1.charCodeAt(i));
        }
        return `string.char(${bytes.join(', ')})`;
    });

    // 2. Aşama: Basit Değişken Bozucu
    const randomName = () => 'lI' + Math.random().toString(36).substring(7).replace(/[0-9]/g, 'I');
    obfCode = obfCode.replace(/local\s+([a-zA-Z_]\w*)\s*=/g, `local ${randomName()} =`);

    // 3. Aşama: Opaque Predicates (Kör Düğümler) Ekleme
    obfCode = insertOpaquePredicates(obfCode);

    res.json({
        status: "success",
        original_length: code.length,
        obfuscated: obfCode
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Obfuscator API ${PORT} portunda ayakta!`));