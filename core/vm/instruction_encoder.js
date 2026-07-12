const encodeInstructions = (ir, opcodeMap, options = {}) => {
    const layout = options.layout || 'flat';
    const encoded = ir.instructions.map(inst => [
        opcodeMap[inst.op],
        inst.a || 0,
        inst.b || 0,
        inst.c || 0
    ]);

    if (layout === 'table') return encoded;
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
    if (layout === 'table') {
        return `{${encoded.map(inst => `{${inst.join(',')}}`).join(',')}}`;
    }
    return `{${encoded.join(',')}}`;
};

module.exports = {
    encodeInstructions,
    renderBytecode,
    renderConstantPool
};
