const { parse, astToCode } = require('../ast_traverser');
const { compileFunctionToIr } = require('./compiler');
const { createOpcodeMap, makeRng, shuffleWithSeed } = require('./opcode_generator');
const { generateInterpreter } = require('./interpreter_generator');
const { selectFunctions } = require('./function_selector');
const { emptyVmMetrics } = require('./metrics');

const rawExpression = (raw) => ({ type: 'RawExpression', raw });

const replaceWithVmClosure = (node, closureSource) => {
    const name = node.identifier.name;
    for (const key of Object.keys(node)) delete node[key];
    Object.assign(node, {
        type: 'LocalStatement',
        variables: [{ type: 'Identifier', name }],
        init: [rawExpression(closureSource)]
    });
};

const virtualizeSource = async (source, options = {}) => {
    const vmMode = options.vmMode || 'off';
    const metrics = emptyVmMetrics(vmMode);
    if (vmMode === 'off') return { code: source, metrics };

    const ast = parse(source, 'vm-input');
    const opcodeMap = createOpcodeMap(options.seed || `${Date.now()}:${Math.random()}`);
    metrics.opcodeMap = opcodeMap;
    const selection = selectFunctions(ast, {
        vmMode,
        strict: options.strict === true
    });
    metrics.selectedFunctions = selection.selected.length;
    metrics.skippedFunctions = selection.skipped.length;
    for (const skipped of selection.skipped) {
        metrics.functions.push({
            name: skipped.name,
            status: `skipped: ${skipped.reason}`,
            instructionCount: 0
        });
    }

    if (selection.selected.length === 0) {
        return {
            code: source,
            metrics
        };
    }

    for (let i = 0; i < selection.selected.length; i++) {
        const fn = selection.selected[i];
        try {
            const ir = compileFunctionToIr(fn, { maxNodes: selection.limits.maxNodes });
            const functionSeed = `${options.seed || 'seed'}:${fn.identifier.name}:${i}`;
            const rng = makeRng(`layout:${functionSeed}`);
            const layouts = ['flat', 'table', 'segmented'];
            const layout = layouts[Math.floor(rng() * layouts.length)];
            const fieldOrder = shuffleWithSeed(['op', 'a', 'b', 'c'], `fields:${functionSeed}`);
            const generated = generateInterpreter({
                ir,
                opcodeMap,
                seed: functionSeed,
                layout,
                fieldOrder
            });
            const functionName = fn.identifier.name;
            replaceWithVmClosure(fn, generated.source);
            metrics.virtualizedFunctions += 1;
            metrics.vmInstructionCount += ir.instructions.length;
            metrics.branchOrders.push(generated.branchOrder);
            metrics.interpreterTemplates.push(generated.interpreterTemplate);
            metrics.instructionLayouts.push({ layout, fieldOrder });
            metrics.functions.push({
                name: functionName,
                status: 'virtualized',
                instructionCount: ir.instructions.length,
                layout,
                fieldOrder,
                interpreterTemplate: generated.interpreterTemplate,
                ir: ir.instructions,
                constants: ir.constants,
                bytecode: generated.bytecode,
                branchOrder: generated.branchOrder
            });
        } catch (err) {
            metrics.skippedFunctions += 1;
            metrics.functions.push({
                name: fn.identifier && fn.identifier.name || `function-${i}`,
                status: `failed: ${err.reason || err.message}`,
                instructionCount: 0
            });
            if (options.strict === true) {
                err.stage = 'vm-compile';
                throw err;
            }
        }
    }

    return {
        code: astToCode(ast),
        metrics
    };
};

module.exports = {
    virtualizeSource
};
