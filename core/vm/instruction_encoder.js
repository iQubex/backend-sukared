const encodeInstructions = (ir, opcodeMap, options = {}) => {
    const layout = options.layout || 'flat';
    const fieldOrder = options.fieldOrder || ['op', 'a', 'b', 'c', 'd'];
    const encoded = ir.instructions.map((inst, instructionIndex) => {
        const codec = options.operandCodec || {};
        const encodeOperand = (field, value) => {
            const config = codec[field];
            return config ? value * config.multiplier + config.offset : value;
        };
        const fields = {
            op: options.opcodeResolver
                ? options.opcodeResolver(inst.op, instructionIndex, inst)
                : opcodeMap[inst.op],
            a: encodeOperand('a', inst.a || 0),
            b: encodeOperand('b', inst.b || 0),
            c: encodeOperand('c', inst.c || 0),
            d: encodeOperand('d', inst.d || 0)
        };
        return fieldOrder.map(field => fields[field]);
    });

    if (layout === 'table') return encoded;
    if (layout === 'segmented') {
        const segmentSize = options.segmentSize || 3;
        const segments = [];
        for (let i = 0; i < encoded.length; i += segmentSize) {
            segments.push(encoded.slice(i, i + segmentSize).flat());
        }
        return segments;
    }
    return encoded.flat();
};

const renderLuaValue = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const bytes = Buffer.from(String(value), 'utf8');
    return `string.char(${[...bytes].join(',')})`;
};

const renderConstantPool = (constants) => `{${constants.map(renderLuaValue).join(',')}}`;

const renderBytecode = (encoded, layout) => {
    if (layout === 'table' || layout === 'segmented') {
        return `{${encoded.map(inst => `{${inst.join(',')}}`).join(',')}}`;
    }
    return `{${encoded.join(',')}}`;
};

module.exports = {
    encodeInstructions,
    renderBytecode,
    renderConstantPool
};
