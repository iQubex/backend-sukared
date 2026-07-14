const { makeRng } = require('./opcode_generator');

const resolveJumpChain = (instructions, target) => {
    const visited = new Set();
    let current = target;
    while (current > 0 && !visited.has(current)) {
        visited.add(current);
        const instruction = instructions[current - 1];
        if (!instruction || instruction.op !== 'JUMP' || instruction.a === current) break;
        current = instruction.a;
    }
    return current;
};

const mutateControlFlow = (instructions, seed) => {
    const output = instructions.map(instruction => ({ ...instruction }));
    const rng = makeRng(`cfg:${seed}`);
    let invertedBranches = 0;
    let rewrittenJumpChains = 0;

    for (let index = 0; index < output.length; index++) {
        const instruction = output[index];
        if (instruction.op === 'JUMP') {
            const target = resolveJumpChain(output, instruction.a);
            if (target !== instruction.a) {
                instruction.a = target;
                rewrittenJumpChains += 1;
            }
        }
        const next = output[index + 1];
        if (instruction.op === 'JUMP_IF' && next?.op === 'JUMP' && rng() < 0.55) {
            const trueTarget = instruction.a;
            instruction.a = next.a;
            instruction.c = instruction.c ? 0 : 1;
            next.a = trueTarget;
            invertedBranches += 1;
        }
    }

    return { instructions: output, invertedBranches, rewrittenJumpChains };
};

module.exports = { mutateControlFlow };
