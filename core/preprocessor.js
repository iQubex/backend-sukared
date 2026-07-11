const legacy = require('../luauPreprocessor');

const preprocess = async (source) => {
    const code = String(source || '');
    return legacy.preprocessLuau(code);
};

module.exports = {
    preprocess,
    parseLuaString: legacy.parseLuaString,
    luaDecimalString: legacy.luaDecimalString
};
