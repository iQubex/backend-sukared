process.env.SUKARED_BUILD_WORKER = '1';

const { obfuscateDetailed } = require('../../server');

process.on('message', async message => {
    if (!message || message.type !== 'build') return;
    try {
        const result = await obfuscateDetailed(message.source, message.options);
        process.send?.({ type: 'result', id: message.id, result });
    } catch (error) {
        process.send?.({
            type: 'error',
            id: message.id,
            error: {
                code: error.code || 'BUILD_FAILED',
                stage: error.stage || null,
                message: error.message || 'Build failed.',
                build: error.code === 'GOOD_VM_NOT_APPLIED' ? error.build : undefined
            }
        });
    }
});
