const { createOpcodeMap, makeRng, shuffleWithSeed } = require('./opcode_generator');
const { encodeInstructions, renderBytecode } = require('./instruction_encoder');
const { shuffleBasicBlocks } = require('./block_shuffler');
const { mutateInstructions } = require('./instruction_mutator');
const { mutateControlFlow } = require('./cfg_mutator');
const { generateInterpreter, INTERPRETER_FAMILIES } = require('./interpreter_generator');
const { materializeImplicitExit, validatePhysicalTransitions } = require('./pc_transition_validator');

const luaStringBytes = (value, key, algorithm = 'shift') => {
    let bytes = [...Buffer.from(String(value), 'utf8')];
    if (algorithm === 'xor') bytes = bytes.map(byte => byte ^ key);
    else if (algorithm === 'rolling') bytes = bytes.map((byte, index) => (byte + key + index + 1) % 256);
    else bytes = bytes.map(byte => (byte + key) % 256);
    if (algorithm === 'reverse') bytes.reverse();
    const mode = { shift: 1, xor: 2, reverse: 3, rolling: 4 }[algorithm] || 1;
    return `{1,{${bytes.join(',')}},${key},${mode}}`;
};
const renderConstant = (value, key = 0, algorithm = 'shift') => {
    if (typeof value === 'string') return luaStringBytes(value, key, algorithm);
    if (typeof value === 'number') return `{2,${Number.isFinite(value) ? value : 0}}`;
    if (typeof value === 'boolean') return `{3,${value ? 'true' : 'false'}}`;
    return '{4,false}';
};

const constantKey = value => `${typeof value}:${String(value)}`;
const countPrototypeTree = ir => (ir.prototypes || []).reduce(
    (total, prototype) => total + 1 + countPrototypeTree(prototype), 0);

const randomizeRuntimeIdentifiers = (source, seed) => {
    const rng = makeRng(`runtime-identifiers:${seed}`);
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const nextName = () => {
        let value = '_';
        for (let index = 0; index < 11; index++) value += alphabet[Math.floor(rng() * alphabet.length)];
        return value;
    };
    const identifiers = [
        'dispatchToken', 'fetchInstruction', 'fetchPhysical', 'physicalIndex', 'dispatchState',
        'stateMap', 'fetchTable', 'invokeState', 'handlers', 'handler', 'returned', 'descriptorVar',
        'segments', 'descriptors', 'resolve', 'capture', 'codec', 'pcmap', 'refs', 'cells',
        'multi', 'entry', 'make', 'args', 'pack', 'env', 'desc', 'item', 'cacheA',
        'cacheB', 'cache', 'receiver', 'closure', 'captures', 'spec', 'frame', 'cursor',
        'physical', 'inst', 'op', 'get', 'set', 'bc', 'uv', 'fid', 'route'
    ];
    const mapping = new Map(identifiers.map(identifier => [identifier, nextName()]));
    let output = source;
    for (const identifier of [...identifiers].sort((a, b) => b.length - a.length)) {
        output = output.replace(new RegExp(`\\b${identifier}\\b`, 'g'), mapping.get(identifier));
    }
    return output;
};

const buildSegmentedPools = (entries, seed, segmentSize = 16, algorithm = 'shift') => {
    const constantRng = makeRng(`constant-bytes:${seed}`);
    const encodeConstant = value => renderConstant(value, Math.floor(constantRng() * 255) + 1, algorithm);
    const usage = new Map();
    entries.forEach((entry, functionIndex) => {
        for (const value of entry.ir.constants) {
            const key = constantKey(value);
            if (!usage.has(key)) usage.set(key, new Set());
            usage.get(key).add(functionIndex);
        }
    });
    const sharedConstants = [];
    const sharedIndexByKey = new Map();
    for (const [key, functions] of usage) {
        if (functions.size > 1) {
            sharedIndexByKey.set(key, sharedConstants.length);
            const match = entries.flatMap(entry => entry.ir.constants).find(value => constantKey(value) === key);
            sharedConstants.push(match);
        }
    }
    const localPools = entries.map(() => []);
    const references = entries.map((entry, functionIndex) => entry.ir.constants.map(value => {
        const key = constantKey(value);
        if (sharedIndexByKey.has(key)) {
            return { shared: true, index: sharedIndexByKey.get(key) };
        }
        const index = localPools[functionIndex].length;
        localPools[functionIndex].push(value);
        return { shared: false, index };
    }));
    const logicalSegments = [];
    for (let index = 0; index < sharedConstants.length; index += segmentSize) {
        logicalSegments.push(sharedConstants.slice(index, index + segmentSize));
    }
    const order = shuffleWithSeed(logicalSegments.map((_, index) => index), `segments:${seed}`);
    const physicalByLogical = new Map(order.map((logical, physical) => [logical, physical]));
    const segments = order.map(logical => logicalSegments[logical]);
    const mappedReferences = references.map(list => list.map(reference => {
        if (!reference.shared) return [2, reference.index + 1, 0];
        const logicalSegment = Math.floor(reference.index / segmentSize);
        return [1, physicalByLogical.get(logicalSegment) + 1, reference.index % segmentSize + 1];
    }));
    return {
        source: `{${segments.map(segment => `{${segment.map(encodeConstant).join(',')}}`).join(',')}}`,
        localSources: localPools.map(pool => `{${pool.map(encodeConstant).join(',')}}`),
        references: mappedReferences,
        segmentCount: segments.length + localPools.filter(pool => pool.length > 0).length,
        clusterSegmentCount: segments.length,
        functionLocalSegmentCount: localPools.filter(pool => pool.length > 0).length,
        sharedConstantCount: sharedConstants.length,
        functionLocalConstantCount: localPools.reduce((total, pool) => total + pool.length, 0),
        lazyConstantCount: sharedConstants.concat(...localPools).filter(value => typeof value === 'string').length,
        totalProtectedConstants: sharedConstants.length + localPools.reduce((total, pool) => total + pool.length, 0)
    };
};

const assignClusters = (entries, seed, maxClusterSize = 6) => {
    const rng = makeRng(`clusters:${seed}`);
    const shuffled = shuffleWithSeed(entries, `cluster-members:${seed}`);
    const clusters = [];
    for (let index = 0; index < shuffled.length;) {
        const remaining = shuffled.length - index;
        const size = Math.min(remaining, Math.max(2, Math.floor(rng() * Math.max(2, maxClusterSize - 1)) + 2));
        clusters.push(shuffled.slice(index, index + size));
        index += size;
    }
    return clusters;
};

const CLUSTER_FAMILIES = [
    'if-chain-v2', 'handler-table-v2', 'segmented-dispatch-v2',
    'computed-state-v2', 'state-machine-v2', 'nested-dispatch-v2', 'mixed-dispatch-v2'
];
const FETCH_FAMILIES = ['mapped-direct-v2', 'frame-pc-v2', 'fetch-closure-v2', 'fetch-table-v2', 'split-index-v2'];
const CALL_FAMILIES = ['direct-call-v2', 'trampoline-call-v2', 'helper-call-v2', 'state-call-v2'];
const CONSTANT_DECODER_FAMILIES = ['indexed-loop-v2', 'while-accumulator-v2', 'decode-helper-v2', 'dual-cache-v2'];

const CONTROL_TARGET_FIELD = instruction => {
    if (['JUMP', 'JUMP_IF'].includes(instruction.op)) return 'a';
    if (['FOR_PREP', 'FOR_LOOP', 'ITER_NEXT'].includes(instruction.op)) return 'd';
    return /_BRANCH$/.test(instruction.op) ? 'a' : null;
};

const physicalizeControlFlow = physical => {
    const logicalByPhysical = [];
    physical.logicalToPhysical.forEach((physicalIndex, logicalIndex) => {
        logicalByPhysical[physicalIndex] = logicalIndex + 1;
    });
    const instructions = physical.instructions.map(instruction => ({ ...instruction }));
    instructions.forEach(instruction => {
        const field = CONTROL_TARGET_FIELD(instruction);
        if (!field || !instruction[field]) return;
        instruction[field] = physical.logicalToPhysical[instruction[field] - 1] || instruction[field];
    });
    const odd = [];
    const even = [];
    for (let physicalIndex = 1; physicalIndex <= instructions.length; physicalIndex++) {
        const logicalIndex = logicalByPhysical[physicalIndex];
        const successor = physical.logicalToPhysical[logicalIndex] || 0;
        (physicalIndex % 2 ? odd : even).push(`[${physicalIndex}]=${successor}`);
    }
    return {
        instructions,
        transitionSource: `{{${odd.join(',')}},{${even.join(',')}},${physical.logicalToPhysical[0] || 1}}`,
        transitionStructureCount: 2
    };
};

const generateCluster = (entries, seed, options = {}) => {
    const interpreterTemplate = options.family || CLUSTER_FAMILIES[0];
    const familyRng = makeRng(`cluster-families:${seed}`);
    const fetchFamily = options.fetchFamily || FETCH_FAMILIES[Math.floor(familyRng() * FETCH_FAMILIES.length)];
    const callFamily = options.callFamily || CALL_FAMILIES[Math.floor(familyRng() * CALL_FAMILIES.length)];
    const constantDecoderFamily = options.constantDecoderFamily
        || CONSTANT_DECODER_FAMILIES[Math.floor(familyRng() * CONSTANT_DECODER_FAMILIES.length)];
    const entryFamily = ['numeric-entry-v2', 'wrapped-entry-v2', 'nested-entry-v2', 'double-wrapper-entry-v2'][Math.floor(familyRng() * 4)];
    const symbolSuffix = Math.floor(familyRng() * 0xffffff).toString(36);
    const descriptorVar = `_d_${symbolSuffix}`;
    const segmentVar = `_s_${symbolSuffix}`;
    const opcodeMap = createOpcodeMap(`cluster:${seed}`);
    const opcodeRng = makeRng(`cluster-extra-opcodes:${seed}`);
    const usedOpcodeValues = new Set(Object.values(opcodeMap));
    const ensureOpcode = name => {
        if (opcodeMap[name] !== undefined) return;
        let value;
        do value = Math.floor(opcodeRng() * 9000) + 1000; while (usedOpcodeValues.has(value));
        usedOpcodeValues.add(value);
        opcodeMap[name] = value;
    };
    const opcodeAliases = new Map();
    const ensureAliases = name => {
        ensureOpcode(name);
        if (opcodeAliases.has(name)) return opcodeAliases.get(name);
        const rng = makeRng(`opcode-alias:${seed}:${name}`);
        const aliases = [opcodeMap[name]];
        const extra = 1 + Math.floor(rng() * 3);
        while (aliases.length <= extra) {
            let value;
            do value = Math.floor(rng() * 9000) + 1000; while (usedOpcodeValues.has(value));
            usedOpcodeValues.add(value);
            aliases.push(value);
        }
        opcodeAliases.set(name, aliases);
        return aliases;
    };
    const fieldOrder = shuffleWithSeed(['op', 'a', 'b', 'c', 'd'], `cluster-fields:${seed}`);
    const positions = Object.fromEntries(fieldOrder.map((field, index) => [field, index + 1]));
    const constantAlgorithm = {
        'indexed-loop-v2': 'shift', 'while-accumulator-v2': 'rolling',
        'decode-helper-v2': 'reverse', 'dual-cache-v2': 'xor'
    }[constantDecoderFamily] || 'shift';
    const pools = buildSegmentedPools(entries, seed, 16, constantAlgorithm);
    let fusedInstructionCount = 0;
    let splitInstructionCount = 0;
    let shuffledBlockCount = 0;
    let invertedBranches = 0;
    let rewrittenJumpChains = 0;
    let splitBlockCount = 0;
    let mergedBlockCount = 0;
    let temporaryRegisterCount = 0;
    let encodedInstructionCount = 0;
    let clusteredPrototypeFunctions = 0;
    let validatedPhysicalPcFunctions = 0;
    let physicalBranchTargetCount = 0;
    let physicalBackwardEdgeCount = 0;
    const fusedFamilies = new Set();
    const splitFamilies = new Set();

    const descriptors = entries.map((entry, entryIndex) => {
        const mutation = mutateInstructions(entry.ir, `${seed}:${entryIndex}`, { expanded: true });
        const cfg = mutateControlFlow(mutation.instructions, `${seed}:${entryIndex}`);
        const controlInstructions = materializeImplicitExit(cfg.instructions);
        const physical = shuffleBasicBlocks(controlInstructions, `${seed}:${entryIndex}`, { expanded: true });
        const rng = makeRng(`cluster-operands:${seed}:${entryIndex}`);
        const codec = Object.fromEntries(['a', 'b', 'c', 'd'].map(field => [field, {
            multiplier: [3, 5, 7, 9, 11][Math.floor(rng() * 5)],
            offset: Math.floor(rng() * 97) + 11
        }]));
        const physicalFlow = physicalizeControlFlow(physical);
        const pcValidation = validatePhysicalTransitions({
            instructions: physicalFlow.instructions,
            logicalToPhysical: physical.logicalToPhysical,
            seed: `${seed}:${entryIndex}`
        });
        validatedPhysicalPcFunctions += 1;
        physicalBranchTargetCount += pcValidation.branchTargetCount;
        physicalBackwardEdgeCount += pcValidation.backwardEdgeCount;
        physicalFlow.instructions.forEach(instruction => ensureAliases(instruction.op));
        const aliasRng = makeRng(`instruction-alias:${seed}:${entryIndex}`);
        const encoded = encodeInstructions({ instructions: physicalFlow.instructions }, opcodeMap, {
            layout: 'table', fieldOrder, operandCodec: codec,
            opcodeResolver: op => {
                const aliases = ensureAliases(op);
                return aliases[Math.floor(aliasRng() * aliases.length)];
            }
        });
        encodedInstructionCount += physical.instructions.length;
        fusedInstructionCount += mutation.fusedInstructionCount;
        splitInstructionCount += mutation.splitInstructionCount;
        shuffledBlockCount += physical.shuffledBlockCount;
        invertedBranches += cfg.invertedBranches;
        rewrittenJumpChains += cfg.rewrittenJumpChains;
        splitBlockCount += physical.splitBlockCount || 0;
        mergedBlockCount += physical.mergedBlockCount || 0;
        temporaryRegisterCount += Math.max(0, (mutation.registerCount || entry.ir.registerCount) - entry.ir.registerCount);
        for (const family of mutation.fusedFamilies || []) fusedFamilies.add(family);
        for (const family of mutation.splitFamilies || []) splitFamilies.add(family);
        const refs = pools.references[entryIndex];
        const refCodec = {
            kindOffset: Math.floor(rng() * 19) + 3,
            xMultiplier: [3, 5, 7][Math.floor(rng() * 3)], xOffset: Math.floor(rng() * 31) + 5,
            yMultiplier: [5, 7, 9][Math.floor(rng() * 3)], yOffset: Math.floor(rng() * 37) + 7
        };
        const encodedRefs = refs.map(ref => `{${ref[0] + refCodec.kindOffset},${ref[1] * refCodec.xMultiplier + refCodec.xOffset},${ref[2] * refCodec.yMultiplier + refCodec.yOffset}}`);
        const generatedPrototypes = (entry.ir.prototypes || []).map((prototype, prototypeIndex) => generateInterpreter({
            ir: prototype,
            opcodeMap,
            seed: `${seed}:cluster-prototype:${entryIndex}:${prototypeIndex}`,
            layout: 'table',
            fieldOrder,
            asFactory: true,
            diversify: true,
            family: INTERPRETER_FAMILIES[(entryIndex + prototypeIndex) % INTERPRETER_FAMILIES.length]
        }));
        const prototypeSource = `{${generatedPrototypes.map(item => item.source).join(',')}}`;
        const closureSpecSource = `{${(entry.ir.closureSpecs || []).map(spec =>
            `{${spec.prototype},{${spec.captures.map(capture =>
                `{${capture.kind === 'upvalue' ? 2 : (capture.kind === 'loop-register' ? 3 : 1)},${capture.index}}`
            ).join(',')}}}`
        ).join(',')}}`;
        const prototypeCount = countPrototypeTree(entry.ir);
        clusteredPrototypeFunctions += prototypeCount;
        encodedInstructionCount += generatedPrototypes.reduce((total, item) => total + item.encodedInstructionCount, 0);
        return `{${renderBytecode(encoded, 'table')},${physicalFlow.transitionSource},{${encodedRefs.join(',')}},{${codec.a.multiplier},${codec.a.offset},${codec.b.multiplier},${codec.b.offset},${codec.c.multiplier},${codec.c.offset},${codec.d.multiplier},${codec.d.offset}},${entry.ir.params.length},${entry.ir.hasVararg ? 1 : 0},${pools.localSources[entryIndex]},{${refCodec.kindOffset},${refCodec.xMultiplier},${refCodec.xOffset},${refCodec.yMultiplier},${refCodec.yOffset}},${prototypeSource},${closureSpecSource}}`;
    });

    const usedOps = [...new Set(entries.flatMap((entry, index) => {
        const mutation = mutateInstructions(entry.ir, `${seed}:${index}`, { expanded: true });
        const cfg = mutateControlFlow(mutation.instructions, `${seed}:${index}`);
        return materializeImplicitExit(cfg.instructions).map(instruction => instruction.op);
    }))];
    const branchOrder = shuffleWithSeed(usedOps, `cluster-branches:${seed}`);
    const p = positions;
    const dispatchSalt = 101 + Math.floor(makeRng(`dispatch-salt:${seed}`)() * 700);
    const opcodeCondition = op => ensureAliases(op).map(value => `dispatchToken==${value + dispatchSalt}`).join(' or ');
    const branch = (op, body, first) => `${first ? 'if' : 'elseif'} ${opcodeCondition(op)} then ${body}`;
    const fakeRng = makeRng(`fake-opcodes:${seed}`);
    const fakeOpcodes = [];
    const fakeOpcodeTarget = 3 + Math.floor(fakeRng() * 5);
    while (fakeOpcodes.length < fakeOpcodeTarget) {
        const value = Math.floor(fakeRng() * 9000) + 1000;
        if (!usedOpcodeValues.has(value)) {
            usedOpcodeValues.add(value);
            fakeOpcodes.push(value);
        }
    }
    let invokeSetup = '';
    let invokeExpression = 'pack(get(a)(unpack(av,1,n)))';
    if (callFamily === 'trampoline-call-v2') {
        invokeSetup = 'local function invoke(fn,av,n)return pack(fn(unpack(av,1,n))) end;';
        invokeExpression = 'invoke(get(a),av,n)';
    } else if (callFamily === 'helper-call-v2') {
        invokeSetup = 'local invoke={};invoke[1]=function(fn,av,n)return pack(fn(unpack(av,1,n))) end;';
        invokeExpression = 'invoke[1](get(a),av,n)';
    } else if (callFamily === 'state-call-v2') {
        const callState = 100 + Math.floor(fakeRng() * 800);
        invokeSetup = `local invokeState={[${callState}]=function(fn,av,n)return pack(fn(unpack(av,1,n))) end};`;
        invokeExpression = `invokeState[${callState}](get(a),av,n)`;
    }
    const bodies = {
        LOAD_CONST: 'set(a,resolve(b))', LOAD_CONST_MOVE: 'local v=resolve(b);set(a,v);set(c,v)',
        LOAD_NIL: 'set(a,nil)', LOAD_BOOL: 'set(a,b~=0)', MOVE: 'set(a,get(b))',
        MULTI_MOVE: 'local n=c==0 and multi or c;for i=1,n do set(a+i-1,get(b+i-1)) end',
        GET_GLOBAL: 'set(a,env[resolve(b)])', SET_GLOBAL: 'env[resolve(b)]=get(a)',
        GET_GLOBAL_CALL: 'local out=pack(env[resolve(b)]());multi=out.n;local count=d==0 and multi or d;for i=1,count do set(a+i-1,out[i]) end',
        GET_UPVALUE: 'set(a,uv[b][1]())', SET_UPVALUE: 'uv[b][2](get(a))', RESET_CELL: 'cells[a]=nil',
        GET_UPVALUE_ADD: 'set(a,uv[b][1]()+get(c))', GET_UPVALUE_SUB: 'set(a,uv[b][1]()-get(c))',
        GET_UPVALUE_MUL: 'set(a,uv[b][1]()*get(c))', GET_UPVALUE_DIV: 'set(a,uv[b][1]()/get(c))',
        NEW_TABLE: 'set(a,{})', GET_TABLE: 'set(a,get(b)[get(c)])', SET_TABLE: 'get(a)[get(b)]=get(c)',
        GET_TABLE_CALL: 'local out=pack(get(b)[get(c)]());multi=out.n;local count=d==0 and multi or d;for i=1,count do set(a+i-1,out[i]) end',
        SELF_CALL: 'local receiver=get(b);local out=pack(receiver[get(c)](receiver));multi=out.n;local count=d==0 and multi or d;for i=1,count do set(a+i-1,out[i]) end',
        SET_LIST: 'local n=d==0 and multi or d;for i=1,n do get(a)[c+i-1]=get(b+i-1) end',
        ADD: 'set(a,get(b)+get(c))', SUB: 'set(a,get(b)-get(c))', MUL: 'set(a,get(b)*get(c))', DIV: 'set(a,get(b)/get(c))',
        ADD_MOVE: 'local v=get(b)+get(c);set(a,v);set(d,v)', SUB_MOVE: 'local v=get(b)-get(c);set(a,v);set(d,v)',
        MUL_MOVE: 'local v=get(b)*get(c);set(a,v);set(d,v)', DIV_MOVE: 'local v=get(b)/get(c);set(a,v);set(d,v)',
        ADD_RETURN: 'return get(b)+get(c)', SUB_RETURN: 'return get(b)-get(c)',
        MUL_RETURN: 'return get(b)*get(c)', DIV_RETURN: 'return get(b)/get(c)',
        CONCAT: 'set(a,get(b)..get(c))', LEN: 'set(a,#get(b))', NOT: 'set(a,not get(b))', UNM: 'set(a,-get(b))',
        EQ: 'set(a,get(b)==get(c))', LT: 'set(a,get(b)<get(c))', LE: 'set(a,get(b)<=get(c))',
        EQ_BRANCH: 'if (get(b)==get(c))==(d~=0) then pc=a end',
        LT_BRANCH: 'if (get(b)<get(c))==(d~=0) then pc=a end',
        LE_BRANCH: 'if (get(b)<=get(c))==(d~=0) then pc=a end',
        GET_TABLE_EQ: 'set(a,get(b)[get(c)]==get(d))', GET_TABLE_LT: 'set(a,get(b)[get(c)]<get(d))',
        GET_TABLE_LE: 'set(a,get(b)[get(c)]<=get(d))',
        CLOSURE: 'local spec=desc[10][b];local captures={};for i,cap in ipairs(spec[2]) do if cap[1]==2 then captures[i]=uv[cap[2]] else captures[i]=capture(cap[2],cap[1]==3) end end;set(a,desc[9][spec[1]](captures))',
        CLOSURE_MOVE: 'local spec=desc[10][b];local captures={};for i,cap in ipairs(spec[2]) do if cap[1]==2 then captures[i]=uv[cap[2]] else captures[i]=capture(cap[2],cap[1]==3) end end;local closure=desc[9][spec[1]](captures);set(a,closure);set(c,closure)',
        JUMP: 'pc=a', JUMP_IF: 'if (get(b) and true or false)==(c~=0) then pc=a end',
        FOR_PREP: 'if not ((get(c)>=0 and get(a)<=get(b)) or (get(c)<0 and get(a)>=get(b))) then pc=d end',
        FOR_LOOP: 'set(a,get(a)+get(c));if ((get(c)>=0 and get(a)<=get(b)) or (get(c)<0 and get(a)>=get(b))) then pc=d end',
        ITER_PREP: 'multi=0',
        ITER_NEXT: 'local out=pack(get(a)(get(a+1),get(a+2)));set(a+2,out[1]);for i=1,c do set(b+i-1,out[i]) end;if out[1]~=nil then pc=d end',
        SELF: 'set(a,get(b)[get(c)]);set(a+1,get(b))',
        CALL: `local n=c<0 and (-c-1+multi) or c;local av={};for i=1,n do av[i]=get(b+i-1) end;local out=${invokeExpression};multi=out.n;local count=d==0 and multi or d;for i=1,count do set(a+i-1,out[i]) end`,
        RETURN: 'if a==0 then return else local n=b==0 and multi or (b<0 and (-b-1+multi) or b);local out={n=n};for i=1,n do out[i]=get(a+i-1) end;return unpack(out,1,n) end',
        VARARG: 'local n=b==0 and args.n-desc[5] or b;multi=n;for i=1,n do set(a+i-1,args[desc[5]+i]) end'
    };
    const fakeBranchBody = 'local shadow=(a+b+c+d)%997;shadow=shadow-shadow';
    const conditionalFor = ops => ops.map((op, index) => branch(op, bodies[op], index === 0)).join(' ')
        + fakeOpcodes.map(value => ` elseif dispatchToken==${value + dispatchSalt} then ${fakeBranchBody}`).join('')
        + ' else error("Hell VM dispatch") end';
    let dispatchSetup = '';
    let dispatch = conditionalFor(branchOrder);
    let dispatcherBlocks = 1;
    let helperBlocks = 0;
    let fakeTransitionCount = fakeOpcodes.length;
    if (interpreterTemplate === 'handler-table-v2') {
        const handlerBodies = {
            ...bodies,
            RETURN: 'if a==0 then return {n=0} else local n=b==0 and multi or (b<0 and (-b-1+multi) or b);local out={n=n};for i=1,n do out[i]=get(a+i-1) end;return out end',
            ADD_RETURN: 'return {n=1,[1]=get(b)+get(c)}', SUB_RETURN: 'return {n=1,[1]=get(b)-get(c)}',
            MUL_RETURN: 'return {n=1,[1]=get(b)*get(c)}', DIV_RETURN: 'return {n=1,[1]=get(b)/get(c)}'
        };
        const canonical = branchOrder.map((op, index) => {
            const handlerName = `handler_${index + 1}`;
            const aliases = ensureAliases(op);
            const setup = `local function ${handlerName}(a,b,c,d) ${handlerBodies[op]} end;`
                + aliases.map(value => `handlers[${value + dispatchSalt}]=${handlerName};`).join('');
            return setup;
        }).join('');
        dispatchSetup = `local handlers={};${canonical}`
            + fakeOpcodes.map(value => `handlers[${value + dispatchSalt}]=function(a,b,c,d) ${fakeBranchBody} end;`).join('');
        dispatch = 'local handler=handlers[dispatchToken];if not handler then error("Hell VM dispatch") end;local returned=handler(a,b,c,d);if returned then return unpack(returned,1,returned.n) end';
        helperBlocks = branchOrder.length;
    } else if (interpreterTemplate === 'segmented-dispatch-v2') {
        dispatch = `repeat ${conditionalFor(branchOrder)} until true`;
        dispatcherBlocks = 2;
    } else if (interpreterTemplate === 'computed-state-v2' || interpreterTemplate === 'state-machine-v2') {
        const states = shuffleWithSeed(branchOrder.map((_, index) => 2000 + index * 37 + Math.floor(fakeRng() * 31)), `states:${seed}`);
        const stateEntries = branchOrder.flatMap((op, index) => ensureAliases(op).map(value => `[${value + dispatchSalt}]=${states[index]}`));
        const fakeStates = fakeOpcodes.map((value, index) => `[${value + dispatchSalt}]=${9000 + index * 13}`);
        dispatchSetup = `local stateMap={${stateEntries.concat(fakeStates).join(',')}};`;
        const stateBranches = branchOrder.map((op, index) => `${index ? 'elseif' : 'if'} dispatchState==${states[index]} then ${bodies[op]}`).join(' ')
            + fakeOpcodes.map((_, index) => ` elseif dispatchState==${9000 + index * 13} then ${fakeBranchBody}`).join('')
            + ' else error("Hell VM state") end';
        dispatch = interpreterTemplate === 'state-machine-v2'
            ? `local dispatchState=stateMap[dispatchToken];repeat ${stateBranches};dispatchState=0 until dispatchState==0`
            : `local dispatchState=stateMap[dispatchToken];${stateBranches}`;
        dispatcherBlocks = branchOrder.length;
        helperBlocks = 1;
    } else if (interpreterTemplate === 'nested-dispatch-v2' || interpreterTemplate === 'mixed-dispatch-v2') {
        const midpoint = Math.ceil(branchOrder.length / 2);
        const left = branchOrder.slice(0, midpoint);
        const right = branchOrder.slice(midpoint);
        const leftCondition = left.flatMap(op => ensureAliases(op)).map(value => `dispatchToken==${value + dispatchSalt}`).join(' or ') || 'false';
        const leftDispatch = conditionalFor(left);
        const rightDispatch = conditionalFor(right);
        dispatch = `if ${leftCondition} then ${leftDispatch} else ${rightDispatch} end`;
        if (interpreterTemplate === 'mixed-dispatch-v2') dispatch = `do local route=(dispatchToken+${fakeOpcodes[0]})%2;${dispatch};route=route-route end`;
        dispatcherBlocks = 2;
    }
    const byteDecodeExpression = constantAlgorithm === 'xor'
        ? 'env.bit32.bxor(item[2][j],item[3])'
        : constantAlgorithm === 'rolling'
            ? '(item[2][j]-item[3]-j)%256'
            : constantAlgorithm === 'reverse'
                ? '(item[2][#item[2]-j+1]-item[3])%256'
                : '(256+item[2][j]-item[3])%256';
    const decodeItemLoop = `local v;if item[1]==1 then local bytes={};for j=1,#item[2] do bytes[j]=${byteDecodeExpression} end;v=string.char(unpack(bytes)) elseif item[1]==2 then v=item[2] elseif item[1]==3 then v=item[2] else v=nil end`;
    const itemLookup = `local ref=refs[i];local rc=desc[8];local kind=ref[1]-rc[1];local x=(ref[2]-rc[3])/rc[2];local y=(ref[3]-rc[5])/rc[4];local item;if kind==1 then item=${segmentVar}[x][y] else item=desc[7][x] end;`;
    let resolverSource;
    let eagerResolveSource = '';
    let constantCacheCount = 1;
    if (constantDecoderFamily === 'while-accumulator-v2') {
        resolverSource = `local cache={};local function resolve(i) if cache[i]~=nil then return cache[i] end;${itemLookup}local v;if item[1]==1 then local bytes={};local j=1;while j<=#item[2] do bytes[j]=${byteDecodeExpression};j=j+1 end;v=string.char(unpack(bytes)) elseif item[1]==2 then v=item[2] elseif item[1]==3 then v=item[2] end;cache[i]=v;if i%7==0 then cache[i]=nil end;return v end;`;
    } else if (constantDecoderFamily === 'decode-helper-v2') {
        resolverSource = `local cache={};local function decodeItem(item) ${decodeItemLoop};return v end;local function resolve(i) local hit=cache[i];if hit~=nil then return hit end;${itemLookup}local v=decodeItem(item);cache[i]=v;return v end;`;
    } else if (constantDecoderFamily === 'dual-cache-v2') {
        constantCacheCount = 2;
        resolverSource = `local cacheA={};local cacheB={};local function resolve(i) local cache=i%2==0 and cacheA or cacheB;if cache[i]~=nil then return cache[i] end;${itemLookup}${decodeItemLoop};cache[i]=v;return v end;`;
        eagerResolveSource = 'for ci=1,#refs do if ci%5==0 then resolve(ci) end end;';
    } else {
        resolverSource = `local cache={};local function resolve(i) if cache[i]~=nil then return cache[i] end;${itemLookup}${decodeItemLoop};cache[i]=v;return v end;`;
    }
    const fetchKey = 300 + Math.floor(fakeRng() * 600);
    let fetchSetup = '';
    let fetchCode = 'local physical=pc;local inst=bc[physical];local lane=pc%2==1 and pcmap[1] or pcmap[2];pc=lane[physical];';
    if (fetchFamily === 'frame-pc-v2') {
        fetchSetup = 'local frame={cursor=pc};';
        fetchCode = 'frame.cursor=pc;local physical=frame.cursor;local inst=bc[physical];local lane=physical%2==1 and pcmap[1] or pcmap[2];pc=lane[physical];';
    } else if (fetchFamily === 'fetch-closure-v2') {
        fetchSetup = 'local function fetchInstruction(cursor)local lane=cursor%2==1 and pcmap[1] or pcmap[2];return bc[cursor],lane[cursor] end;';
        fetchCode = 'local inst,nextPc=fetchInstruction(pc);pc=nextPc;';
        helperBlocks += 1;
    } else if (fetchFamily === 'fetch-table-v2') {
        fetchSetup = `local fetchTable={[${fetchKey}]=function(cursor)local lane=cursor%2==1 and pcmap[1] or pcmap[2];return bc[cursor],lane[cursor] end};`;
        fetchCode = `local inst,nextPc=fetchTable[${fetchKey}](pc);pc=nextPc;`;
        helperBlocks += 1;
    } else if (fetchFamily === 'split-index-v2') {
        fetchSetup = 'local function physicalIndex(cursor)return cursor end;local function fetchPhysical(index)local lane=index%2==1 and pcmap[1] or pcmap[2];return bc[index],lane[index] end;';
        fetchCode = 'local physical=physicalIndex(pc);local inst,nextPc=fetchPhysical(physical);pc=nextPc;';
        helperBlocks += 2;
    }
    const decodeOperands = `local op=inst[${p.op}];local dispatchToken=op+${dispatchSalt};local a=(inst[${p.a}]-codec[2])/codec[1];local b=(inst[${p.b}]-codec[4])/codec[3];local c=(inst[${p.c}]-codec[6])/codec[5];local d=(inst[${p.d}]-codec[8])/codec[7];`;
    const entryKey = 400 + Math.floor(fakeRng() * 500);
    const entryExport = entryFamily === 'numeric-entry-v2'
        ? `{[${entryKey}]=make}`
        : entryFamily === 'wrapped-entry-v2'
            ? '{open=function(fid,uv)return make(fid,uv) end}'
            : entryFamily === 'nested-entry-v2'
                ? '{bridge={make}}'
                : '{outer={inner=function(fid,uv)return make(fid,uv) end}}';
    const entryAccess = entryFamily === 'numeric-entry-v2'
        ? `[${entryKey}]`
        : entryFamily === 'wrapped-entry-v2'
            ? '.open'
            : entryFamily === 'nested-entry-v2'
                ? '.bridge[1]'
                : '.outer.inner';
    const descriptorSource = `{${descriptors.join(',')}}`;
    const rawSource = `(function() local ${descriptorVar}=${descriptorSource};local ${segmentVar}=${pools.source};local function make(fid,uv) local function entry(...) local desc=${descriptorVar}[fid];local bc=desc[1];local pcmap=desc[2];local refs=desc[3];local codec=desc[4];local env=getfenv();local unpack=env.unpack or env.table.unpack;local function pack(...) return {n=env.select("#",...),...} end;${invokeSetup}local args=pack(...);local r={};local cells={};local function get(i) local cell=cells[i];if cell then return cell[1] end return r[i] end;local function set(i,v) r[i]=v;local cell=cells[i];if cell then cell[1]=v end end;local function capture(index,isolated)local cell;if isolated then cell={get(index)} else cell=cells[index];if not cell then cell={get(index)};cells[index]=cell end end;return {function()return cell[1] end,function(value)cell[1]=value;if not isolated then r[index]=value end end} end;${resolverSource}${eagerResolveSource}local multi=0;for i=1,desc[5] do set(i,args[i]) end;local pc=pcmap[3];${fetchSetup}${dispatchSetup}while true do ${fetchCode}${decodeOperands}${dispatch} end end;return entry end;return ${entryExport} end)()`;
    const source = randomizeRuntimeIdentifiers(rawSource, seed);
    return {
        source,
        opcodeMap,
        interpreterTemplate,
        entryAccess,
        entries,
        metrics: {
            clusteredFunctions: entries.length + clusteredPrototypeFunctions,
            clusteredPrototypeFunctions,
            constantPoolSegments: pools.segmentCount,
            clusterConstantSegments: pools.clusterSegmentCount,
            functionLocalConstantSegments: pools.functionLocalSegmentCount,
            sharedConstantCount: pools.sharedConstantCount,
            functionLocalConstantCount: pools.functionLocalConstantCount,
            lazyConstantCount: pools.lazyConstantCount,
            decodedAtStartupCount: 0,
            totalProtectedConstants: pools.totalProtectedConstants,
            fusedInstructionCount,
            splitInstructionCount,
            fusedOpcodeFamilies: [...fusedFamilies],
            splitOpcodeFamilies: [...splitFamilies],
            shuffledBlockCount,
            invertedBranches,
            rewrittenJumpChains,
            splitBlockCount,
            mergedBlockCount,
            temporaryRegisterCount,
            instructionCount: encodedInstructionCount,
            branchOrder,
            dispatchFamily: interpreterTemplate,
            fetchFamily,
            callFamily,
            entryFamily,
            constantDecoderFamily,
            constantCacheCount,
            fakeOpcodeCount: fakeOpcodes.length,
            fakeHandlerCount: fakeOpcodes.length,
            opcodeAliasCount: [...opcodeAliases.values()].reduce((total, aliases) => total + aliases.length - 1, 0),
            averageAliasesPerOpcode: opcodeAliases.size
                ? Number(([...opcodeAliases.values()].reduce((total, aliases) => total + aliases.length, 0) / opcodeAliases.size).toFixed(2)) : 0,
            cfgVariant: `${interpreterTemplate}:${fetchFamily}`,
            dispatcherBlocks,
            helperBlocks,
            deadStateCount: fakeOpcodes.length,
            fakeTransitionCount,
            transitionStructureCount: entries.length * 2,
            validatedPhysicalPcFunctions,
            physicalBranchTargetCount,
            physicalBackwardEdgeCount,
            decodedAtStartupCount: constantDecoderFamily === 'dual-cache-v2'
                ? pools.references.reduce((total, refs) => total + Math.floor(refs.length / 5), 0) : 0
        }
    };
};

module.exports = { CLUSTER_FAMILIES, assignClusters, generateCluster };
