const crypto = require('crypto');

const PROFILES = {
    light: {
        deadCodeProbability: 0,
        decoderFamilies: ['shift', 'bytes'],
        inlineStringRate: 0.08,
        flattenRate: 0,
        defaultVmMode: 'off',
        integrity: false,
        hideNumbers: false,
        safeAlphabet: true
    },
    balanced: {
        deadCodeProbability: 0.02,
        decoderFamilies: ['shift', 'bytes', 'xor'],
        inlineStringRate: 0.3,
        flattenRate: 0.08,
        defaultVmMode: 'off',
        integrity: true,
        hideNumbers: true,
        safeAlphabet: true
    },
    strong: {
        deadCodeProbability: 0.22,
        decoderFamilies: ['shift', 'reverseShift', 'bytes', 'closure', 'xor', 'stateful', 'tableDriven', 'runtimeGenerated'],
        inlineStringRate: 0.5,
        flattenRate: 0.75,
        defaultVmMode: 'selected',
        integrity: true,
        hideNumbers: true,
        safeAlphabet: false
    }
};

const makeRandomId = () => crypto.randomBytes(5).toString('hex').toUpperCase();

const createBuildConfig = (options = {}) => {
    const profileName = ['light', 'balanced', 'strong'].includes(options.profile) ? options.profile : 'balanced';
    const profile = { ...PROFILES[profileName] };
    return {
        ...profile,
        profile: profileName,
        version: options.version || '1.0',
        randomId: makeRandomId(),
        fingerprint: `SR-${options.version || '1.0'}-${makeRandomId()}`,
        digitFree: options.digitFree === true,
        safeAlphabet: options.safeAlphabet ?? profile.safeAlphabet,
        vmMode: options.vmMode || profile.defaultVmMode,
        decoderFamilies: options.decoderFamilies || profile.decoderFamilies,
        vmBudgets: options.vmBudgets || null,
        useVm: options.useVm === true || options.vm === true,
        deadCodeProbability: typeof options.deadCodeProbability === 'number' ? options.deadCodeProbability : profile.deadCodeProbability
    };
};

module.exports = {
    PROFILES,
    createBuildConfig
};
