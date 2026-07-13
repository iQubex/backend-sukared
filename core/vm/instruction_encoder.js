const encodeInstructions = (ir, opcodeMap, options = {}) => {
    const layout = options.layout || 'flat';
    const fieldOrder = options.fieldOrder || ['op', 'a', 'b', 'c'];
    const encoded = ir.instructions.map(inst => {
        const fields = {
            op: opcodeMap[inst.op],
            a: inst.a || 0,
            b: inst.b || 0,
            c: inst.c || 0
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
