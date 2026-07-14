const { shuffleWithSeed } = require('./opcode_generator');

const TARGET_FIELDS = {
    JUMP: 'a',
    JUMP_IF: 'a',
    FOR_PREP: 'd',
    FOR_LOOP: 'd',
    ITER_NEXT: 'd'
};

const TERMINATORS = new Set(['JUMP', 'JUMP_IF', 'RETURN', 'FOR_PREP', 'FOR_LOOP', 'ITER_NEXT']);

const shuffleBasicBlocks = (instructions, seed, options = {}) => {
    if (instructions.length < 2) {
        return {
            instructions: [...instructions], logicalToPhysical: [1], blockOrder: [1],
            shuffledBlockCount: 0, splitBlockCount: 0, mergedBlockCount: 0
        };
    }
    const leaders = new Set([0]);
    instructions.forEach((instruction, index) => {
        const targetField = TARGET_FIELDS[instruction.op] || (/_BRANCH$/.test(instruction.op) ? 'a' : null);
        if (targetField && instruction[targetField] > 0) leaders.add(instruction[targetField] - 1);
        if ((TERMINATORS.has(instruction.op) || /_BRANCH$/.test(instruction.op)) && index + 1 < instructions.length) leaders.add(index + 1);
    });
    const starts = [...leaders].filter(index => index >= 0 && index < instructions.length).sort((a, b) => a - b);
    let blocks = starts.map((start, index) => ({
        id: index + 1,
        indices: Array.from({ length: (starts[index + 1] || instructions.length) - start }, (_, offset) => start + offset)
    }));
    let splitBlockCount = 0;
    let mergedBlockCount = 0;
    if (options.expanded === true) {
        const split = [];
        for (const block of blocks) {
            if (block.indices.length > 3) {
                const midpoint = Math.ceil(block.indices.length / 2);
                split.push({ id: `${block.id}a`, indices: block.indices.slice(0, midpoint) });
                split.push({ id: `${block.id}b`, indices: block.indices.slice(midpoint) });
                splitBlockCount += 1;
            } else split.push(block);
        }
        blocks = split;
        const merged = [];
        for (let index = 0; index < blocks.length; index++) {
            if (blocks[index].indices.length === 1 && blocks[index + 1]?.indices.length === 1) {
                merged.push({ id: `${blocks[index].id}+${blocks[index + 1].id}`, indices: [...blocks[index].indices, ...blocks[index + 1].indices] });
                mergedBlockCount += 1;
                index += 1;
            } else merged.push(blocks[index]);
        }
        blocks = merged;
    }
    const shuffled = shuffleWithSeed(blocks, `blocks:${seed}`);
    const physicalIndices = shuffled.flatMap(block => block.indices);
    const logicalToPhysical = Array(instructions.length);
    physicalIndices.forEach((logicalIndex, physicalIndex) => { logicalToPhysical[logicalIndex] = physicalIndex + 1; });
    const moved = shuffled.reduce((count, block, index) => count + (block.id !== index + 1 ? 1 : 0), 0);
    return {
        instructions: physicalIndices.map(index => instructions[index]),
        logicalToPhysical,
        blockOrder: shuffled.map(block => block.id),
        shuffledBlockCount: moved,
        splitBlockCount,
        mergedBlockCount
    };
};

module.exports = { shuffleBasicBlocks };
