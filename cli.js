#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const { obfuscateDetailed } = require('./server');

const parseArgs = (argv) => {
    const args = { profile: 'balanced' };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-o' || arg === '--output') args.output = argv[++i];
        else if (arg === '--profile') args.profile = argv[++i] || 'balanced';
        else if (arg === '--vm') {
            const next = argv[i + 1];
            if (['off', 'selected', 'aggressive'].includes(next)) args.vmMode = argv[++i];
            else args.vmMode = 'selected';
        }
        else if (arg === '--vm-strict') args.vmStrict = true;
        else if (arg === '--seed') args.seed = argv[++i];
        else if (arg === '--digit-free') args.digitFree = true;
        else if (arg === '--version') args.version = argv[++i] || '1.0';
        else positional.push(arg);
    }
    args.input = positional[0];
    return args;
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    if (!args.input || !args.output) {
        console.error('Usage: sukared input.lua -o output.lua --profile strong --vm selected [--vm-strict]');
        process.exit(1);
    }
    const inputPath = path.resolve(args.input);
    const outputPath = path.resolve(args.output);
    const source = await fs.readFile(inputPath, 'utf8');
    const result = await obfuscateDetailed(source, args);
    await fs.writeFile(outputPath, result.code, 'utf8');
    console.log(`SukaRed wrote ${outputPath}`);
    if (result.build) {
        console.log(`Profile: ${result.build.profile}`);
        console.log(`VM Mode: ${result.build.vmMode}`);
        console.log(`Virtualized Functions: ${result.build.virtualizedFunctions}`);
    }
};

main().catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
});
