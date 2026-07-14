const luaparse = require('luaparse');
const crypto = require('crypto');

const NON_ASCII_STRING = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;

const tryParse = (code) => {
    try {
        return luaparse.parse(code, { comments: false, luaVersion: '5.2' });
    } catch (_) {
        return null;
    }
};

const countDirectDecoderShape = (code) => {
    const helper = String.raw`(?:_SR[A-Z]_[A-Za-z]{8,}|_[lIO_]{8,})`;
    const direct = String(code || '').match(new RegExp(String.raw`\b${helper}\("[^"]+",(?:\d|#|\(|"|\+|-|\*|\/|%)+\)`, 'g')) || [];
    const indirect = String(code || '').match(new RegExp(String.raw`\(function\(|\{\s*${helper}\s*\}\)|\[[^\]]+\]\("[^"]+"`, 'g')) || [];
    const total = direct.length + indirect.length;
    return {
        direct: direct.length,
        indirect: indirect.length,
        ratio: total ? direct.length / total : 0
    };
};

const collectAlphabetMaps = (code) => {
    const maps = [];
    const regex = /local\s+_M=\{((?:\["[^"]+"\]=[^,}]+,?)+)\}/g;
    let match;
    while ((match = regex.exec(String(code || '')))) {
        const glyphs = [...match[1].matchAll(/\["([^"]+)"\]=/g)].map(item => item[1]).join('|');
        if (glyphs) maps.push(glyphs);
    }
    return maps;
};

const alphabetReuseRatio = (code) => {
    const maps = collectAlphabetMaps(code);
    if (!maps.length) return 0;
    let max = 0;
    for (const map of maps) max = Math.max(max, maps.filter(item => item === map).length);
    return max / maps.length;
};

const staticStringRecoveryRatio = (code) => {
    const text = String(code || '');
    let strings = 0;
    let recovered = 0;
    let match;
    while ((match = NON_ASCII_STRING.exec(text))) {
        if (!/[^\x00-\x7F]/.test(match[1])) continue;
        strings++;
    }
    const directStatic = text.match(/\b(?:_SR[A-Z]_[A-Za-z]{8,}|_[lIO_]{8,})\("[^"]*[^\x00-\x7F][^"]*",[\d\s+\-*/%^#()"!$&.,:;<>?]+\)/g) || [];
    recovered += directStatic.length;
    return strings ? Math.min(1, recovered / strings) : 0;
};

const analyzeObfuscatedCode = (code) => {
    const direct = countDirectDecoderShape(code);
    return {
        parseable: Boolean(tryParse(code)),
        directDecoderCallRatio: Number(direct.ratio.toFixed(3)),
        directDecoderCallCount: direct.direct,
        indirectDecoderCallCount: direct.indirect,
        alphabetReuseRatio: Number(alphabetReuseRatio(code).toFixed(3)),
        staticRecoveredStringRatio: Number(staticStringRecoveryRatio(code).toFixed(3))
    };
};

const normalizedAstFingerprint = (code) => {
    const ast = tryParse(code);
    if (!ast) return null;
    const shape = [];
    const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.type) shape.push(`${node.type}:${node.operator || node.indexer || ''}`);
        for (const [key, value] of Object.entries(node)) {
            if (['loc', 'range', 'raw', 'value', 'name'].includes(key)) continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(ast);
    return crypto.createHash('sha256').update(shape.join('|')).digest('hex').slice(0, 16);
};

const compareNormalizedBuilds = (outputs) => {
    const fingerprints = outputs.map(normalizedAstFingerprint).filter(Boolean);
    const counts = fingerprints.reduce((map, fingerprint) => {
        map.set(fingerprint, (map.get(fingerprint) || 0) + 1);
        return map;
    }, new Map());
    const largestCluster = Math.max(0, ...counts.values());
    return {
        buildCount: outputs.length,
        parseableBuildCount: fingerprints.length,
        uniqueNormalizedFingerprints: counts.size,
        normalizedSimilarity: fingerprints.length
            ? Number((largestCluster / fingerprints.length).toFixed(3))
            : 1,
        fingerprints
    };
};

module.exports = {
    analyzeObfuscatedCode,
    normalizedAstFingerprint,
    compareNormalizedBuilds
};
