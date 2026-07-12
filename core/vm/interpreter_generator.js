const { shuffleWithSeed } = require('./opcode_generator');
const { encodeInstructions, renderBytecode, renderConstantPool } = require('./instruction_encoder');

const name = (prefix, seed) => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let out = `_${prefix}_`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    for (let i = 0; i < 10; i++) {
        hash = (hash * 1664525 + 1013904223) >>> 0;
        out += chars[hash % chars.length];
    }
    return out;
};

const createBranch = (opName, code, opcodeMap) => `if ${name('op', opName)}==${opcodeMap[opName]} then ${code}`;

const generateInterpreter = ({ ir, opcodeMap, seed, layout = 'flat' }) => {
    const bc = name('bc', seed);
    const k = name('k', seed);
    const r = name('r', seed);
    const pc = name('pc', seed);
    const inst = name('inst', seed);
    const op = name('op', seed);
    const a = name('a', seed);
    const b = name('b', seed);
    const c = name('c', seed);
    const env = name('env', seed);
    const args = name('args', seed);
    const encoded = encodeInstructions(ir, opcodeMap, { layout });
    const bytecode = renderBytecode(encoded, layout);
    const constants = renderConstantPool(ir.constants);

    const fetch = layout === 'table'
        ? `local ${inst}=${bc}[${pc}];local ${op}=${inst}[1];local ${a}=${inst}[2];local ${b}=${inst}[3];local ${c}=${inst}[4];${pc}=${pc}+1`
        : `local ${op}=${bc}[${pc}];local ${a}=${bc}[${pc}+1];local ${b}=${bc}[${pc}+2];local ${c}=${bc}[${pc}+3];${pc}=${pc}+4`;

    const opVar = name('op', 'LOAD_CONST');
    const branchOrder = shuffleWithSeed(Object.keys(opcodeMap), `branch:${seed}`);
    const branches = branchOrder.map((opName, index) => {
        const prefix = index === 0 ? 'if' : 'elseif';
        const cond = `${op}==${opcodeMap[opName]}`;
        const bodies = {
            LOAD_CONST: `${r}[${a}]=${k}[${b}]`,
            MOVE: `${r}[${a}]=${r}[${b}]`,
            GET_GLOBAL: `${r}[${a}]=${env}[${k}[${b}]]`,
            ADD: `${r}[${a}]=${r}[${b}]+${r}[${c}]`,
            SUB: `${r}[${a}]=${r}[${b}]-${r}[${c}]`,
            MUL: `${r}[${a}]=${r}[${b}]*${r}[${c}]`,
            DIV: `${r}[${a}]=${r}[${b}]/${r}[${c}]`,
            CALL: `if ${c}==0 then ${r}[${a}]=${r}[${a}]() elseif ${c}==1 then ${r}[${a}]=${r}[${a}](${r}[${b}]) elseif ${c}==2 then ${r}[${a}]=${r}[${a}](${r}[${b}],${r}[${b}+1]) elseif ${c}==3 then ${r}[${a}]=${r}[${a}](${r}[${b}],${r}[${b}+1],${r}[${b}+2]) else error("SukaRed VM error") end`,
            RETURN: `return ${r}[${a}]`
        };
        return `${prefix} ${cond} then ${bodies[opName]}`;
    }).join(' ');

    const paramLoads = ir.params.map((_, index) => `${r}[${index + 1}]=${args}[${index + 1}]`).join(';');

    const source = `(function(...) local ${env}=getfenv();local ${args}={...};local ${k}=${constants};local ${bc}=${bytecode};local ${r}={};${paramLoads};local ${pc}=1;while true do ${fetch};${branches} else error("SukaRed VM error") end end end)`;
    return {
        source,
        bytecode: encoded,
        branchOrder,
        layout
    };
};

module.exports = {
    generateInterpreter
};
