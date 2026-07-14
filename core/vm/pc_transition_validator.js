const TARGET_FIELD = instruction => {
    if (['JUMP', 'JUMP_IF'].includes(instruction.op)) return 'a';
    if (['FOR_PREP', 'FOR_LOOP', 'ITER_NEXT'].includes(instruction.op)) return 'd';
    return /_BRANCH$/.test(instruction.op) ? 'a' : null;
};

const materializeImplicitExit = instructions => {
    const output = instructions.map(instruction => ({ ...instruction }));
    const implicitExit = output.length + 1;
    const requiresExit = output.some(instruction => {
        const field = TARGET_FIELD(instruction);
        return field && instruction[field] === implicitExit;
    });
    if (requiresExit) output.push({ op: 'RETURN', a: 0, b: 0, c: 0, d: 0, syntheticExit: true });
    return output;
};

const fail = (message, details) => {
    const error = new Error(`Invalid physical PC transition: ${message}; details=${JSON.stringify(details)}`);
    error.code = 'INVALID_PHYSICAL_PC';
    error.stage = 'vm-pc-remap';
    error.details = details;
    throw error;
};

const validatePhysicalTransitions = ({ instructions, logicalToPhysical, seed = 'unknown' }) => {
    const count = instructions.length;
    if (logicalToPhysical.length !== count) {
        fail('logical/physical cardinality mismatch', { seed, count, mapped: logicalToPhysical.length });
    }
    const seenPhysical = new Set(logicalToPhysical);
    if (seenPhysical.size !== count || [...seenPhysical].some(index => index < 1 || index > count)) {
        fail('mapping is not a physical permutation', { seed, count, logicalToPhysical });
    }

    const logicalByPhysical = [];
    logicalToPhysical.forEach((physical, logical) => { logicalByPhysical[physical] = logical + 1; });
    const successors = Array(count + 1).fill(0);
    const branchTargets = [];
    for (let physical = 1; physical <= count; physical++) {
        const logical = logicalByPhysical[physical];
        successors[physical] = logicalToPhysical[logical] || 0;
        const instruction = instructions[physical - 1];
        const field = TARGET_FIELD(instruction);
        if (!field || !instruction[field]) continue;
        const target = instruction[field];
        if (!Number.isInteger(target) || target < 1 || target > count) {
            fail('dangling or out-of-range branch target', {
                seed, physicalPc: physical, op: instruction.op, field, branchTarget: target, instruction
            });
        }
        branchTargets.push({ physicalPc: physical, op: instruction.op, field, target });
    }

    const entry = logicalToPhysical[0] || 1;
    const reachable = new Set();
    const queue = [entry];
    while (queue.length) {
        const physical = queue.pop();
        if (!physical || reachable.has(physical)) continue;
        if (physical < 1 || physical > count) fail('reachable PC escaped bytecode', { seed, physical });
        reachable.add(physical);
        const instruction = instructions[physical - 1];
        if (instruction.op !== 'RETURN' && successors[physical]) queue.push(successors[physical]);
        const field = TARGET_FIELD(instruction);
        if (field && instruction[field]) queue.push(instruction[field]);
    }
    const unreachable = Array.from({ length: count }, (_, index) => index + 1)
        .filter(index => !reachable.has(index));
    if (instructions.some(instruction => instruction.op === 'RETURN')
        && ![...reachable].some(index => instructions[index - 1].op === 'RETURN')) {
        fail('terminating source graph has no reachable RETURN', { seed });
    }
    return {
        valid: true,
        entry,
        instructionCount: count,
        transitionStructureCount: 2,
        branchTargetCount: branchTargets.length,
        backwardEdgeCount: branchTargets.filter(item => item.target < item.physicalPc).length,
        reachableInstructionCount: reachable.size,
        sourceDeadInstructionCount: unreachable.length
    };
};

const assertNoCompleteLogicalMap = code => {
    const text = String(code);
    if (/logicalToPhysical/.test(text)) fail('generated output exposes logicalToPhysical', {});
    const explicitOldTemplate = /local\s+physical\s*=\s*pcmap\s*\[\s*(?:cursor|pc)\s*\]/;
    return {
        valid: !explicitOldTemplate.test(text),
        completeLogicalMapEmitted: explicitOldTemplate.test(text)
    };
};

module.exports = { TARGET_FIELD, materializeImplicitExit, validatePhysicalTransitions, assertNoCompleteLogicalMap };
