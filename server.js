const express = require('express');
const cors = require('cors'); // 1. EKLENEN SATIR: Kütüphaneyi çağırdık

const app = express();

app.use(cors()); // 2. EKLENEN SATIR: Tarayıcı engellerini kaldırdık
app.use(express.json());

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

    res.json({
        status: "success",
        original_length: code.length,
        obfuscated: obfCode
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Obfuscator API ${PORT} portunda ayakta!`));