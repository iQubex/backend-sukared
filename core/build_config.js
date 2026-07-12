const crypto = require('crypto');

const PROFILES = {
    light: {
        deadCodeProbability: 0.05,
        decoderFamilies: ['shift'],
        inlineStringRate: 0.15,
        flattenRate: 0,
        vm: false,
        integrity: false,
        hideNumbers: false
    },
    balanced: {
        deadCodeProbability: 0.12,
        decoderFamilies: ['shift', 'reverseShift', 'bytes', 'xor', 'tableDriven'],
        inlineStringRate: 0.3,
        flattenRate: 0.35,
        vm: false,
        integrity: true,
        hideNumbers: true
    },
    strong: {
        deadCodeProbability: 0.22,
        decoderFamilies: ['shift', 'reverseShift', 'bytes', 'closure', 'xor', 'stateful', 'tableDriven', 'runtimeGenerated'],
        inlineStringRate: 0.5,
        flattenRate: 0.75,
        vm: true,
        integrity: true,
        hideNumbers: true
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
        useVm: options.useVm === true || options.vm === true || profile.vm === true,
        deadCodeProbability: typeof options.deadCodeProbability === 'number' ? options.deadCodeProbability : profile.deadCodeProbability
    };
};

module.exports = {
    PROFILES,
    createBuildConfig
};
