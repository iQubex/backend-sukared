const { shuffleWithSeed, makeRng } = require('./opcode_generator');
const { encodeInstructions, renderBytecode, renderConstantPool } = require('./instruction_encoder');
const { buildDispatch } = require('./dispatch_generator');
const { shuffleBasicBlocks } = require('./block_shuffler');
const { mutateInstructions } = require('./instruction_mutator');
const { TARGET_FIELD, materializeImplicitExit, validatePhysicalTransitions } = require('./pc_transition_validator');

const INTERPRETER_FAMILIES = [
    'conditional-register-v1',
    'handler-table-v1',
    'segmented-state-v1',
    'hybrid-dispatch-v1'
];

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

const generateInterpreter = ({ ir, opcodeMap, seed, layout = 'flat', fieldOrder = ['op', 'a', 'b', 'c', 'd'], asFactory = false, family = 'conditional-register-v1', diversify = false }) => {
    const bc = name('bc', seed);
    const k = name('k', seed);
    const r = name('r', seed);
    const pc = name('pc', seed);
    const inst = name('inst', seed);
    const op = name('op', seed);
    const a = name('a', seed);
    const b = name('b', seed);
    const c = name('c', seed);
    const d = name('d', seed);
    const env = name('env', seed);
    const upvalues = name('uv', seed);
    const suppliedUpvalues = name('supplied', seed);
    const cells = name('cells', seed);
    const getRegister = name('get', seed);
    const setRegister = name('set', seed);
    const captureRegister = name('capture', seed);
    const closureSpecs = name('specs', seed);
    const captureList = name('captures', seed);
    const spec = name('spec', seed);
    const descriptor = name('descriptor', seed);
    const callArgs = name('callargs', seed);
    const selfRef = name('self', seed);
    const args = name('args', seed);
    const pack = name('pack', seed);
    const unpack = name('unpack', seed);
    const count = name('count', seed);
    const result = name('result', seed);
    const multi = name('multi', seed);
    const loop = name('i', seed);
    const segment = name('seg', seed);
    const offset = name('off', seed);
    const handlers = name('handlers', seed);
    const response = name('response', seed);
    const stateMap = name('states', seed);
    const state = name('state', seed);
    const segmentSize = 3;
    const mutation = mutateInstructions(ir, seed);
    const constantOrder = shuffleWithSeed(ir.constants.map((_, index) => index), `constants:${seed}`);
    const constantIndexMap = new Map(constantOrder.map((oldIndex, newIndex) => [oldIndex + 1, newIndex + 1]));
    const constantOps = new Set(['LOAD_CONST', 'GET_GLOBAL', 'SET_GLOBAL']);
    const encodedIr = {
        ...ir,
        constants: constantOrder.map(index => ir.constants[index]),
        instructions: mutation.instructions.map(instruction => constantOps.has(instruction.op) || instruction.op === 'LOAD_CONST_MOVE'
            ? { ...instruction, b: constantIndexMap.get(instruction.b) }
            : instruction)
    };
    encodedIr.instructions = materializeImplicitExit(encodedIr.instructions);
    const shuffledBlocks = shuffleBasicBlocks(encodedIr.instructions, seed);
    let physicalInstructions = shuffledBlocks.instructions.map(instruction => ({ ...instruction }));
    if (diversify) {
        physicalInstructions.forEach(instruction => {
            const field = TARGET_FIELD(instruction);
            if (field && instruction[field]) {
                instruction[field] = shuffledBlocks.logicalToPhysical[instruction[field] - 1] || instruction[field];
            }
        });
        validatePhysicalTransitions({
            instructions: physicalInstructions,
            logicalToPhysical: shuffledBlocks.logicalToPhysical,
            seed
        });
    }
    const physicalIr = { ...encodedIr, instructions: physicalInstructions };
    const operandRng = makeRng(`operands:${seed}`);
    const operandCodec = Object.fromEntries(['a', 'b', 'c', 'd'].map(field => [field, {
        multiplier: [3, 5, 7, 9, 11][Math.floor(operandRng() * 5)],
        offset: Math.floor(operandRng() * 97) + 11
    }]));
    const encoded = encodeInstructions(physicalIr, opcodeMap, { layout, fieldOrder, segmentSize, operandCodec });
    const bytecode = renderBytecode(encoded, layout);
    const constants = renderConstantPool(encodedIr.constants);
    const prototypes = name('proto', seed);
    const generatedPrototypes = (ir.prototypes || []).map((prototype, index) => generateInterpreter({
        ir: prototype,
        opcodeMap,
        seed: `${seed}:prototype:${index}`,
        layout,
        fieldOrder,
        asFactory: true,
        diversify,
        family: INTERPRETER_FAMILIES[(INTERPRETER_FAMILIES.indexOf(family) + index + 1) % INTERPRETER_FAMILIES.length]
    }));
    const prototypeTable = `{${generatedPrototypes.map(item => item.source).join(',')}}`;
    const closureSpecTable = `{${(ir.closureSpecs || []).map(item =>
        `{${item.prototype},{${item.captures.map(capture =>
            `{${capture.kind === 'register' ? 1 : (capture.kind === 'upvalue' ? 2 : 3)},${capture.index}}`
        ).join(',')}}}`
    ).join(',')}}`;
    const pcMap = name('pcmap', seed);
    const physicalPc = name('physical', seed);
    const cursor = name('cursor', seed);
    const logicalByPhysical = [];
    shuffledBlocks.logicalToPhysical.forEach((physical, logical) => { logicalByPhysical[physical] = logical + 1; });
    const oddTransitions = [];
    const evenTransitions = [];
    for (let physical = 1; physical <= physicalInstructions.length; physical++) {
        const logical = logicalByPhysical[physical];
        const successor = shuffledBlocks.logicalToPhysical[logical] || 0;
        (physical % 2 ? oddTransitions : evenTransitions).push(`[${physical}]=${successor}`);
    }
    const pcMapTable = diversify
        ? `{{${oddTransitions.join(',')}},{${evenTransitions.join(',')}},${shuffledBlocks.logicalToPhysical[0] || 1}}`
        : `{${shuffledBlocks.logicalToPhysical.join(',')}}`;
    const jumpTarget = a;
    const jumpTargetD = d;

    const positions = Object.fromEntries(fieldOrder.map((field, index) => [field, index + 1]));
    let fetch;
    const cursorSetup = diversify ? `local ${cursor}=${pc};` : '';
    const cursorRef = diversify ? cursor : pc;
    if (layout === 'table') {
        fetch = diversify
            ? `${cursorSetup}local ${physicalPc}=${cursorRef};local ${inst}=${bc}[${physicalPc}];local ${op}=${inst}[${positions.op}];local ${a}=${inst}[${positions.a}];local ${b}=${inst}[${positions.b}];local ${c}=${inst}[${positions.c}];local ${d}=${inst}[${positions.d}];local _lane=${physicalPc}%2==1 and ${pcMap}[1] or ${pcMap}[2];${pc}=_lane[${physicalPc}]`
            : `${cursorSetup}local ${physicalPc}=${pcMap}[${cursorRef}];local ${inst}=${bc}[${physicalPc}];local ${op}=${inst}[${positions.op}];local ${a}=${inst}[${positions.a}];local ${b}=${inst}[${positions.b}];local ${c}=${inst}[${positions.c}];local ${d}=${inst}[${positions.d}];${pc}=${pc}+1`;
    } else if (layout === 'segmented') {
        const physicalLookup = diversify ? cursorRef : `${pcMap}[${cursorRef}]`;
        const advance = diversify
            ? `local _lane=${physicalPc}%2==1 and ${pcMap}[1] or ${pcMap}[2];${pc}=_lane[${physicalPc}]`
            : `${pc}=${pc}+1`;
        fetch = `${cursorSetup}local ${physicalPc}=${physicalLookup};local ${segment}=math.floor((${physicalPc}-1)/${segmentSize})+1;local ${offset}=((${physicalPc}-1)%${segmentSize})*5+1;local ${inst}=${bc}[${segment}];local ${op}=${inst}[${offset}+${positions.op - 1}];local ${a}=${inst}[${offset}+${positions.a - 1}];local ${b}=${inst}[${offset}+${positions.b - 1}];local ${c}=${inst}[${offset}+${positions.c - 1}];local ${d}=${inst}[${offset}+${positions.d - 1}];${advance}`;
    } else {
        const physicalInstruction = diversify ? cursorRef : `${pcMap}[${cursorRef}]`;
        const advance = diversify
            ? `local _lane=${physicalInstruction}%2==1 and ${pcMap}[1] or ${pcMap}[2];${pc}=_lane[${physicalInstruction}]`
            : `${pc}=${pc}+1`;
        fetch = `${cursorSetup}local ${physicalPc}=(${physicalInstruction}-1)*5+1;local ${op}=${bc}[${physicalPc}+${positions.op - 1}];local ${a}=${bc}[${physicalPc}+${positions.a - 1}];local ${b}=${bc}[${physicalPc}+${positions.b - 1}];local ${c}=${bc}[${physicalPc}+${positions.c - 1}];local ${d}=${bc}[${physicalPc}+${positions.d - 1}];${advance}`;
    }
    fetch += `;${a}=(${a}-${operandCodec.a.offset})/${operandCodec.a.multiplier};${b}=(${b}-${operandCodec.b.offset})/${operandCodec.b.multiplier};${c}=(${c}-${operandCodec.c.offset})/${operandCodec.c.multiplier};${d}=(${d}-${operandCodec.d.offset})/${operandCodec.d.multiplier}`;

    const opVar = name('op', 'LOAD_CONST');
    const usedOpcodes = [...new Set(physicalInstructions.map(instruction => instruction.op))];
    const branchOrder = shuffleWithSeed(usedOpcodes, `branch:${seed}`);
    const bodies = {
            LOAD_CONST: `${setRegister}(${a},${k}[${b}])`,
            LOAD_CONST_MOVE: `${setRegister}(${a},${k}[${b}]);${setRegister}(${c},${k}[${b}])`,
            LOAD_NIL: `${setRegister}(${a},nil)`,
            LOAD_BOOL: `${setRegister}(${a},${b}~=0)`,
            MOVE: `${setRegister}(${a},${getRegister}(${b}))`,
            MULTI_MOVE: `local ${count}=${c}==0 and ${multi} or ${c};for ${loop}=1,${count} do ${setRegister}(${a}+${loop}-1,${getRegister}(${b}+${loop}-1)) end`,
            GET_GLOBAL: `${setRegister}(${a},${env}[${k}[${b}]])`,
            SET_GLOBAL: `${env}[${k}[${b}]]=${getRegister}(${a})`,
            GET_UPVALUE: `${setRegister}(${a},${upvalues}[${b}][1]())`,
            SET_UPVALUE: `${upvalues}[${b}][2](${getRegister}(${a}))`,
            CLOSURE: `local ${spec}=${closureSpecs}[${b}];local ${captureList}={};for ${loop},${descriptor} in ipairs(${spec}[2]) do if ${descriptor}[1]==2 then ${captureList}[${loop}]=${upvalues}[${descriptor}[2]] else ${captureList}[${loop}]=${captureRegister}(${descriptor}[2],${descriptor}[1]==3) end end;${setRegister}(${a},${prototypes}[${spec}[1]](${captureList}))`,
            RESET_CELL: `${cells}[${a}]=nil`,
            NEW_TABLE: `${setRegister}(${a},{})`,
            GET_TABLE: `${setRegister}(${a},${getRegister}(${b})[${getRegister}(${c})])`,
            SET_TABLE: `${getRegister}(${a})[${getRegister}(${b})]=${getRegister}(${c})`,
            SET_LIST: `local ${count}=${d}==0 and ${multi} or ${d};for ${loop}=1,${count} do ${getRegister}(${a})[${c}+${loop}-1]=${getRegister}(${b}+${loop}-1) end`,
            ADD: `${setRegister}(${a},${getRegister}(${b})+${getRegister}(${c}))`,
            SUB: `${setRegister}(${a},${getRegister}(${b})-${getRegister}(${c}))`,
            MUL: `${setRegister}(${a},${getRegister}(${b})*${getRegister}(${c}))`,
            DIV: `${setRegister}(${a},${getRegister}(${b})/${getRegister}(${c}))`,
            CONCAT: `${setRegister}(${a},${getRegister}(${b})..${getRegister}(${c}))`,
            LEN: `${setRegister}(${a},#${getRegister}(${b}))`,
            NOT: `${setRegister}(${a},not ${getRegister}(${b}))`,
            UNM: `${setRegister}(${a},-${getRegister}(${b}))`,
            EQ: `${setRegister}(${a},${getRegister}(${b})==${getRegister}(${c}))`,
            LT: `${setRegister}(${a},${getRegister}(${b})<${getRegister}(${c}))`,
            LE: `${setRegister}(${a},${getRegister}(${b})<=${getRegister}(${c}))`,
            JUMP: `${pc}=${jumpTarget}`,
            JUMP_IF: `if (${getRegister}(${b}) and true or false)==(${c}~=0) then ${pc}=${jumpTarget} end`,
            FOR_PREP: `if not ((${getRegister}(${c})>=0 and ${getRegister}(${a})<=${getRegister}(${b})) or (${getRegister}(${c})<0 and ${getRegister}(${a})>=${getRegister}(${b}))) then ${pc}=${jumpTargetD} end`,
            FOR_LOOP: `${setRegister}(${a},${getRegister}(${a})+${getRegister}(${c}));if ((${getRegister}(${c})>=0 and ${getRegister}(${a})<=${getRegister}(${b})) or (${getRegister}(${c})<0 and ${getRegister}(${a})>=${getRegister}(${b}))) then ${pc}=${jumpTargetD} end`,
            ITER_PREP: `${multi}=0`,
            ITER_NEXT: `local ${result}=${pack}(${getRegister}(${a})(${getRegister}(${a}+1),${getRegister}(${a}+2)));${setRegister}(${a}+2,${result}[1]);for ${loop}=1,${c} do ${setRegister}(${b}+${loop}-1,${result}[${loop}]) end;if ${result}[1]~=nil then ${pc}=${jumpTargetD} end`,
            SELF: `${setRegister}(${a},${getRegister}(${b})[${getRegister}(${c})]);${setRegister}(${a}+1,${getRegister}(${b}))`,
            CALL: `local ${count}=${c}<0 and (-${c}-1+${multi}) or ${c};local ${callArgs}={};for ${loop}=1,${count} do ${callArgs}[${loop}]=${getRegister}(${b}+${loop}-1) end;local ${result}=${pack}(${getRegister}(${a})(${unpack}(${callArgs},1,${count})));${multi}=${result}.n;local ${count}=${d}==0 and ${multi} or ${d};for ${loop}=1,${count} do ${setRegister}(${a}+${loop}-1,${result}[${loop}]) end`,
            RETURN: `if ${a}==0 then return else local ${count}=${b}==0 and ${multi} or (${b}<0 and (-${b}-1+${multi}) or ${b});local ${callArgs}={n=${count}};for ${loop}=1,${count} do ${callArgs}[${loop}]=${getRegister}(${a}+${loop}-1) end;return ${unpack}(${callArgs},1,${count}) end`,
            VARARG: `local ${count}=${b}==0 and ${args}.n-${ir.params.length} or ${b};${multi}=${count};for ${loop}=1,${count} do ${setRegister}(${a}+${loop}-1,${args}[${ir.params.length}+${loop}]) end`
    };
    const handlerBodies = {
        ...bodies,
        RETURN: `if ${a}==0 then return {n=0} else local ${count}=${b}==0 and ${multi} or (${b}<0 and (-${b}-1+${multi}) or ${b});local ${callArgs}={n=${count}};for ${loop}=1,${count} do ${callArgs}[${loop}]=${getRegister}(${a}+${loop}-1) end;return ${callArgs} end`
    };
    const dispatch = buildDispatch({
        family,
        branchOrder,
        opcodeMap,
        bodies,
        handlerBodies,
        names: { op, a, b, c, d, unpack, response, handlers, stateMap, state },
        seed
    });

    const paramLoads = ir.params.map((_, index) => `${setRegister}(${index + 1},${args}[${index + 1}])`).join(';');
    const paramSection = paramLoads ? `${paramLoads};` : '';

    const upvalueCells = (ir.upvalues || []).map(upvalue => {
        const target = upvalue === ir.selfName ? selfRef : upvalue;
        return `{function() return ${target} end,function(value) ${target}=value end}`;
    }).join(',');
    const wrapperStart = asFactory ? `(function(${suppliedUpvalues})` : '(function()';
    const upvalueInit = asFactory ? `${suppliedUpvalues} or {}` : `{${upvalueCells}}`;
    const wrapperEnd = asFactory ? ' end)' : ' end)()';
    const dispatchSetup = dispatch.setup ? `${dispatch.setup};` : '';
    const source = `${wrapperStart} local ${selfRef};local ${upvalues}=${upvalueInit};local ${prototypes}=${prototypeTable};local ${closureSpecs}=${closureSpecTable};${selfRef}=function(...) local ${env}=getfenv();local ${pack}=function(...) return {n=${env}.select("#",...),...} end;local ${unpack}=${env}.unpack or ${env}.table.unpack;local ${args}=${pack}(...);local ${k}=${constants};local ${bc}=${bytecode};local ${pcMap}=${pcMapTable};local ${r}={};local ${cells}={};local ${getRegister}=function(index) local cell=${cells}[index];if cell then return cell[1] end;return ${r}[index] end;local ${setRegister}=function(index,value) ${r}[index]=value;local cell=${cells}[index];if cell then cell[1]=value end end;local ${captureRegister}=function(index,isolated) local cell;if isolated then cell={${getRegister}(index)} else cell=${cells}[index];if not cell then cell={${getRegister}(index)};${cells}[index]=cell end end;return {function() return cell[1] end,function(value) cell[1]=value;if not isolated then ${r}[index]=value end end} end;local ${multi}=0;${paramSection}local ${pc}=${diversify ? `${pcMap}[3]` : '1'};${dispatchSetup}while true do ${fetch};${dispatch.execute} end end;return ${selfRef}${wrapperEnd}`;
    return {
        source,
        bytecode: encoded,
        branchOrder,
        layout,
        fieldOrder,
        interpreterTemplate: family
        ,constantPoolStrategy: 'function-local-shuffled-v1'
        ,blockOrder: shuffledBlocks.blockOrder
        ,shuffledBlockCount: shuffledBlocks.shuffledBlockCount
        ,operandEncoding: 'affine-field-v1'
        ,fusedInstructionCount: mutation.fusedInstructionCount
        ,splitInstructionCount: mutation.splitInstructionCount
        ,encodedInstructionCount: physicalInstructions.length + generatedPrototypes.reduce((total, item) => total + item.encodedInstructionCount, 0)
        ,nested: generatedPrototypes
    };
};

module.exports = {
    generateInterpreter,
    INTERPRETER_FAMILIES
};
