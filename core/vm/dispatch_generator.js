const conditionalChain = (ops, selector, opcodeMap, bodies, errorCode) => {
    if (!ops.length) return errorCode;
    return `${ops.map((op, index) => `${index ? 'elseif' : 'if'} ${selector}==${opcodeMap[op]} then ${bodies[op]}`).join(' ')} else ${errorCode} end`;
};

const handlerDefinitions = (ops, table, opcodeMap, bodies, operands) => ops
    .map(op => `${table}[${opcodeMap[op]}]=function(${operands.join(',')}) ${bodies[op]} end`)
    .join(';');

const buildDispatch = ({ family, branchOrder, opcodeMap, bodies, handlerBodies, names, seed }) => {
    const { op, a, b, c, d, unpack, response } = names;
    const operands = [a, b, c, d];
    const errorCode = `error(${JSON.stringify(`VM dispatch ${seed.slice(-8)}`)})`;

    if (family === 'handler-table-v1') {
        const handlers = names.handlers;
        return {
            setup: `local ${handlers}={};${handlerDefinitions(branchOrder, handlers, opcodeMap, handlerBodies, operands)}`,
            execute: `local ${response}=${handlers}[${op}];if not ${response} then ${errorCode} end;${response}=${response}(${a},${b},${c},${d});if ${response} then return ${unpack}(${response},1,${response}.n) end`
        };
    }

    if (family === 'segmented-state-v1') {
        const stateMap = names.stateMap;
        const state = names.state;
        const usedStates = new Set();
        const stateValues = Object.fromEntries(branchOrder.map((name, index) => {
            let value = ((opcodeMap[name] * 31 + index * 977) % 8000) + 1000;
            while (usedStates.has(value)) value = ((value - 1000 + 7919) % 8000) + 1000;
            usedStates.add(value);
            return [name, value];
        }));
        const stateBodies = Object.fromEntries(branchOrder.map(name => [name, `${bodies[name]};${state}=0`]));
        const stateOpcodes = Object.fromEntries(branchOrder.map(name => [name, stateValues[name]]));
        return {
            setup: `local ${stateMap}={${branchOrder.map(name => `[${opcodeMap[name]}]=${stateValues[name]}`).join(',')}}`,
            execute: `local ${state}=${stateMap}[${op}];if not ${state} then ${errorCode} end;repeat ${conditionalChain(branchOrder, state, stateOpcodes, stateBodies, errorCode)} until ${state}==0`
        };
    }

    if (family === 'hybrid-dispatch-v1') {
        const handlers = names.handlers;
        const hotSet = new Set(['RETURN', 'CALL', 'CLOSURE', 'JUMP', 'JUMP_IF', 'FOR_PREP', 'FOR_LOOP', 'ITER_NEXT']);
        const hot = branchOrder.filter(name => hotSet.has(name));
        const cold = branchOrder.filter(name => !hotSet.has(name));
        const hotDispatch = hot.length
            ? conditionalChain(hot, op, opcodeMap, bodies, errorCode)
            : errorCode;
        return {
            setup: `local ${handlers}={};${handlerDefinitions(cold, handlers, opcodeMap, bodies, operands)}`,
            execute: `local ${response}=${handlers}[${op}];if ${response} then ${response}(${a},${b},${c},${d}) else ${hotDispatch} end`
        };
    }

    return {
        setup: '',
        execute: conditionalChain(branchOrder, op, opcodeMap, bodies, errorCode)
    };
};

module.exports = { buildDispatch };
