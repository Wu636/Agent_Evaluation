const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Load real project helpers while each regression test mocks external services.
function createSourceLoader() {
    const root = path.resolve(__dirname, '..');
    const cache = new Map();
    function load(id, parent = path.join(root, 'entry.ts')) {
        if (!id.startsWith('@/') && !id.startsWith('.')) return require(id);
        const base = id.startsWith('@/')
            ? path.join(root, id.slice(2))
            : path.resolve(path.dirname(parent), id);
        const file = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]
            .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (!file) throw new Error(`Project test dependency not found: ${id}`);
        if (cache.has(file)) return cache.get(file).exports;
        const mod = { exports: {} };
        cache.set(file, mod);
        const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
        }).outputText;
        new Function('require', 'module', 'exports', source)(dependency => load(dependency, file), mod, mod.exports);
        return mod.exports;
    }
    return load;
}

module.exports = { createSourceLoader };
