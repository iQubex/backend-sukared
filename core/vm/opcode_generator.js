const crypto = require('crypto');

const PHASE1_OPCODES = [
    'LOAD_CONST',
    'LOAD_CONST_MOVE',
    'LOAD_NIL',
    'LOAD_BOOL',
    'MOVE',
    'MULTI_MOVE',
    'GET_GLOBAL',
    'SET_GLOBAL',
    'GET_UPVALUE',
    'SET_UPVALUE',
    'CLOSURE',
    'RESET_CELL',
    'NEW_TABLE',
    'GET_TABLE',
    'SET_TABLE',
    'SET_LIST',
    'ADD',
    'SUB',
    'MUL',
    'DIV',
    'CONCAT',
    'LEN',
    'NOT',
    'UNM',
    'EQ',
    'LT',
    'LE',
    'JUMP',
    'JUMP_IF',
    'FOR_PREP',
    'FOR_LOOP',
    'ITER_PREP',
    'ITER_NEXT',
    'SELF',
    'CALL',
    'RETURN',
    'VARARG'
];

const makeRng = (seed = '') => {
    let counter = 0;
    return () => {
        const hash = crypto.createHash('sha256').update(`${seed}:${counter++}`).digest();
        return hash.readUInt32BE(0) / 0xffffffff;
    };
};

const shuffleWithSeed = (items, seed) => {
    const rng = makeRng(seed);
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

const createOpcodeMap = (seed) => {
    const shuffled = shuffleWithSeed(PHASE1_OPCODES, seed);
    const map = {};
    const used = new Set();
    const rng = makeRng(`opcode-value:${seed}`);
    for (const name of shuffled) {
        let value;
        do {
            value = Math.floor(rng() * 9000) + 1000;
        } while (used.has(value));
        used.add(value);
        map[name] = value;
    }
    return map;
};

module.exports = {
    PHASE1_OPCODES,
    makeRng,
    createOpcodeMap,
    shuffleWithSeed
};
