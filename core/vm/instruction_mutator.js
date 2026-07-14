const { makeRng } = require('./opcode_generator');

const CONTROL_OPS = new Set(['JUMP', 'JUMP_IF', 'FOR_PREP', 'FOR_LOOP', 'ITER_NEXT']);
const TARGET_FIELDS = { JUMP: 'a', JUMP_IF: 'a', FOR_PREP: 'd', FOR_LOOP: 'd', ITER_NEXT: 'd' };
const ARITHMETIC = new Set(['ADD', 'SUB', 'MUL', 'DIV']);
const COMPARISONS = new Set(['EQ', 'LT', 'LE']);

const mutateExpanded = (ir, seed) => {
    const rng = makeRng(`expanded-mutation:${seed}`);
    const input = ir.instructions;
    const output = [];
    const oldToNew = new Map();
    const fusedFamilies = new Set();
    const splitFamilies = new Set();
    let registerCount = ir.registerCount;
    let fusedInstructionCount = 0;
    let splitInstructionCount = 0;

    const consume = (index, count, instruction, family) => {
        const target = output.length + 1;
        for (let offset = 0; offset < count; offset++) oldToNew.set(index + offset + 1, target);
        output.push(instruction);
        if (family) fusedFamilies.add(family);
        fusedInstructionCount += count - 1;
        return count;
    };

    for (let index = 0; index < input.length;) {
        const current = input[index];
        const next = input[index + 1];
        const third = input[index + 2];
        if (current.op === 'GET_GLOBAL' && next?.op === 'MOVE' && next.b === current.a
            && third?.op === 'CALL' && third.a === next.a && third.c === 0) {
            index += consume(index, 3, { op: 'GET_GLOBAL_CALL', a: third.a, b: current.b, c: 0, d: third.d }, 'GET_GLOBAL_CALL');
            continue;
        }
        if (current.op === 'GET_TABLE' && next?.op === 'MOVE' && next.b === current.a
            && third?.op === 'CALL' && third.a === next.a && third.c === 0) {
            index += consume(index, 3, { op: 'GET_TABLE_CALL', a: third.a, b: current.b, c: current.c, d: third.d }, 'GET_TABLE_CALL');
            continue;
        }
        if (current.op === 'SELF' && next?.op === 'MOVE' && next.b === current.a + 1
            && third?.op === 'CALL' && third.a === current.a && third.b === next.a && third.c === 1) {
            index += consume(index, 3, { op: 'SELF_CALL', a: current.a, b: current.b, c: current.c, d: third.d }, 'SELF_CALL');
            continue;
        }
        if (COMPARISONS.has(current.op) && next?.op === 'JUMP_IF' && next.b === current.a) {
            index += consume(index, 2, { op: `${current.op}_BRANCH`, a: next.a, b: current.b, c: current.c, d: next.c }, 'COMPARISON_BRANCH');
            continue;
        }
        if (current.op === 'GET_TABLE' && COMPARISONS.has(next?.op) && next.b === current.a) {
            index += consume(index, 2, { op: `GET_TABLE_${next.op}`, a: next.a, b: current.b, c: current.c, d: next.c }, 'GET_TABLE_COMPARISON');
            continue;
        }
        if (current.op === 'GET_UPVALUE' && ARITHMETIC.has(next?.op) && next.b === current.a) {
            index += consume(index, 2, { op: `GET_UPVALUE_${next.op}`, a: next.a, b: current.b, c: next.c, d: 0 }, 'GET_UPVALUE_ARITHMETIC');
            continue;
        }
        if (current.op === 'CLOSURE' && next?.op === 'MOVE' && next.b === current.a) {
            index += consume(index, 2, { op: 'CLOSURE_MOVE', a: current.a, b: current.b, c: next.a, d: 0 }, 'CLOSURE_CAPTURE_MOVE');
            continue;
        }
        if (current.op === 'LOAD_CONST' && next?.op === 'MOVE' && next.b === current.a) {
            index += consume(index, 2, { op: 'LOAD_CONST_MOVE', a: current.a, b: current.b, c: next.a, d: 0 }, 'LOAD_CONST_MOVE');
            continue;
        }
        if (ARITHMETIC.has(current.op) && next?.op === 'MOVE' && next.b === current.a) {
            index += consume(index, 2, { op: `${current.op}_MOVE`, a: current.a, b: current.b, c: current.c, d: next.a }, 'ARITHMETIC_MOVE');
            continue;
        }
        if (ARITHMETIC.has(current.op) && next?.op === 'RETURN' && next.a === current.a && next.b === 1) {
            index += consume(index, 2, { op: `${current.op}_RETURN`, a: current.a, b: current.b, c: current.c, d: 0 }, 'ARITHMETIC_RETURN');
            continue;
        }
        oldToNew.set(index + 1, output.length + 1);
        if (!CONTROL_OPS.has(current.op) && current.op === 'MOVE' && rng() < 0.28) {
            registerCount += 1;
            output.push({ op: 'MOVE', a: registerCount, b: current.b, c: 0, d: 0 });
            output.push({ op: 'MOVE', a: current.a, b: registerCount, c: 0, d: 0 });
            splitInstructionCount += 1;
            splitFamilies.add('REGISTER_RELAY');
        } else output.push({ ...current });
        index += 1;
    }
    oldToNew.set(input.length + 1, output.length + 1);
    for (const instruction of output) {
        const field = TARGET_FIELDS[instruction.op] || (/_BRANCH$/.test(instruction.op) ? 'a' : null);
        if (field && instruction[field] > 0) instruction[field] = oldToNew.get(instruction[field]) || instruction[field];
    }
    return {
        instructions: output, registerCount, fusedInstructionCount, splitInstructionCount,
        fusedFamilies: [...fusedFamilies], splitFamilies: [...splitFamilies]
    };
};

const mutateInstructions = (ir, seed, options = {}) => {
    if (options.expanded === true) return mutateExpanded(ir, seed);
    if (ir.instructions.some(instruction => CONTROL_OPS.has(instruction.op))) {
        return { instructions: ir.instructions, registerCount: ir.registerCount, fusedInstructionCount: 0, splitInstructionCount: 0 };
    }
    const rng = makeRng(`mutation:${seed}`);
    const output = [];
    let fusedInstructionCount = 0;
    let splitInstructionCount = 0;
    const splitFamilies = new Set();
    let registerCount = ir.registerCount;
    for (let index = 0; index < ir.instructions.length; index++) {
        const instruction = ir.instructions[index];
        const next = ir.instructions[index + 1];
        if (instruction.op === 'LOAD_CONST' && next?.op === 'MOVE' && next.b === instruction.a) {
            output.push({ op: 'LOAD_CONST_MOVE', a: instruction.a, b: instruction.b, c: next.a, d: 0 });
            fusedInstructionCount += 1;
            index += 1;
            continue;
        }
        if (options.expanded === true
            && ['ADD', 'SUB', 'MUL', 'DIV'].includes(instruction.op)
            && next?.op === 'MOVE'
            && next.b === instruction.a) {
            output.push({ op: `${instruction.op}_MOVE`, a: instruction.a, b: instruction.b, c: instruction.c, d: next.a });
            fusedInstructionCount += 1;
            index += 1;
            continue;
        }
        if (options.expanded === true
            && ['ADD', 'SUB', 'MUL', 'DIV'].includes(instruction.op)
            && next?.op === 'RETURN'
            && next.a === instruction.a
            && next.b === 1) {
            output.push({ op: `${instruction.op}_RETURN`, a: instruction.a, b: instruction.b, c: instruction.c, d: 0 });
            fusedInstructionCount += 1;
            index += 1;
            continue;
        }
        if (['ADD', 'SUB', 'MUL', 'DIV', 'CONCAT', 'EQ', 'LT', 'LE'].includes(instruction.op) && rng() < 0.45) {
            registerCount += 1;
            output.push({ op: 'MOVE', a: registerCount, b: instruction.b, c: 0, d: 0 });
            output.push({ ...instruction, b: registerCount });
            splitInstructionCount += 1;
            splitFamilies.add('OPERAND_RELAY');
            continue;
        }
        if (['LEN', 'NOT', 'UNM'].includes(instruction.op) && rng() < 0.35) {
            registerCount += 1;
            output.push({ op: 'MOVE', a: registerCount, b: instruction.b, c: 0, d: 0 });
            output.push({ ...instruction, b: registerCount });
            splitInstructionCount += 1;
            splitFamilies.add('UNARY_RELAY');
            continue;
        }
        if (options.expanded === true && instruction.op === 'MOVE' && rng() < 0.3) {
            registerCount += 1;
            output.push({ op: 'MOVE', a: registerCount, b: instruction.b, c: 0, d: 0 });
            output.push({ op: 'MOVE', a: instruction.a, b: registerCount, c: 0, d: 0 });
            splitInstructionCount += 1;
            splitFamilies.add('REGISTER_RELAY');
            continue;
        }
        output.push(instruction);
    }
    return { instructions: output, registerCount, fusedInstructionCount, splitInstructionCount, splitFamilies: [...splitFamilies] };
};

module.exports = { mutateInstructions };
