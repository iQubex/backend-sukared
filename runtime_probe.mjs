delete WebAssembly.Suspending;
delete WebAssembly.promising;

const { LuauState } = await import('./node_modules/luau-web/src/index.js');

const out = [];
const state = await LuauState.createAsync({
    print: (...args) => out.push(args.map(String).join(' '))
});

for (const source of [
    'print(type(getfenv))',
    'print(type(getfenv()))',
    'print(type(getfenv().string), type(string))',
    'print(type(getfenv()["string"]), type(getfenv()["print"]))',
    'print(type(table), type(math), type(error), type(loadstring))'
]) {
    out.length = 0;
    try {
        const fn = state.loadstring(source, 'probe', true);
        await fn();
        console.log(source, '=>', out.join('|'));
    } catch (err) {
        console.log(source, 'ERR', err && err.toString ? err.toString() : String(err));
    }
}

state.destroy();
