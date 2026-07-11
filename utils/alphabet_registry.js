const shuffle = (items) => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

const ALPHABET_POOLS = [
    ['\u2801', '\u2802', '\u2803', '\u2804', '\u2805', '\u2806', '\u2807', '\u2808', '\u2809', '\u280A', '\u280B', '\u280C', '\u280D', '\u280E', '\u280F', '\u2810'],
    ['\u30A2', '\u30A4', '\u30A6', '\u30A8', '\u30AA', '\u30AB', '\u30AD', '\u30AF', '\u30B1', '\u30B3', '\u30B5', '\u30B7', '\u30B9', '\u30BB', '\u30BD', '\u30BF'],
    ['\u0905', '\u0906', '\u0907', '\u0908', '\u0909', '\u090A', '\u090F', '\u0910', '\u0913', '\u0915', '\u0916', '\u0917', '\u091A', '\u091C', '\u091F', '\u0921'],
    ['\u4E00', '\u4E8C', '\u4E09', '\u56DB', '\u4E94', '\u516D', '\u4E03', '\u516B', '\u4E5D', '\u5341', '\u6708', '\u706B', '\u6C34', '\u6728', '\u91D1', '\u571F'],
    ['\u0F00', '\u0F01', '\u0F02', '\u0F03', '\u0F04', '\u0F05', '\u0F06', '\u0F07', '\u0F08', '\u0F09', '\u0F0A', '\u0F0B', '\u0F0C', '\u0F0D', '\u0F0E', '\u0F0F'],
    ['\u203B', '\u2042', '\u2051', '\u205C', '\u25C8', '\u25C7', '\u25C6', '\u25CC', '\u25CE', '\u25C9', '\u25CD', '\u25D0', '\u25D1', '\u25D2', '\u25D3', '\u25D4'],
    ['\u16A0', '\u16A2', '\u16A6', '\u16A8', '\u16B1', '\u16B7', '\u16B9', '\u16C1', '\u16C7', '\u16C9', '\u16D2', '\u16D6', '\u16DA', '\u16DF', '\u16E0', '\u16EB'],
    ['\u2234', '\u2235', '\u22C7', '\u22C9', '\u22CB', '\u22CC', '\u22CF', '\u22D0', '\u22D4', '\u22D6', '\u22D8', '\u22DA', '\u22EE', '\u22F0', '\u29C9', '\u29CA'],
    ['\u2C80', '\u2C81', '\u2C82', '\u2C83', '\u2C84', '\u2C85', '\u2C86', '\u2C87', '\u2C88', '\u2C89', '\u2C8A', '\u2C8B', '\u2C8C', '\u2C8D', '\u2C8E', '\u2C8F']
];

const VM_ALPHABET_CHARS = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_',
    '\u16A0', '\u16A2', '\u16A6', '\u16A8', '\u16B1', '\u16B7', '\u16C1', '\u16D2',
    '\u2234', '\u2235', '\u22C7', '\u22CB', '\u22D4', '\u22EE', '\u29C9', '\u29CA'
];

const selectCipherAlphabet = (size = 16) => {
    const pool = ALPHABET_POOLS[Math.floor(Math.random() * ALPHABET_POOLS.length)];
    return shuffle(pool).slice(0, size);
};

const selectVmAlphabet = (size = 64) => shuffle(VM_ALPHABET_CHARS).slice(0, size).join('');

const makeDecoyAlphabet = (size = 64) => shuffle(ALPHABET_POOLS.flat()).slice(0, size).join('');

module.exports = {
    ALPHABET_POOLS,
    selectCipherAlphabet,
    selectVmAlphabet,
    makeDecoyAlphabet,
    shuffle
};
