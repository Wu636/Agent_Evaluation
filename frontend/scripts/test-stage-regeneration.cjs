const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const cache = new Map();
function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    new Function('require', 'module', 'exports', source)((id) => {
        if (id.startsWith('@/')) return load(path.join(root, id.slice(2)) + '.ts');
        if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id) + (id.endsWith('.ts') ? '' : '.ts'));
        return require(id);
    }, mod, mod.exports);
    return mod.exports;
}
const { parseTrainingScript } = load(path.join(root, 'lib/training-injector/parser.ts'));
const { extractScriptStructure, replaceStageInScript, hasTrainingScriptCompleteMarker } = load(path.join(root, 'lib/training-generator/script-tools.ts'));
const stage = (n, marked, text = `提示词${n}`) => [
    marked ? `<!-- STAGE_START:${n} -->` : '',
    `### 阶段${n}: 测试${n}`, `阶段描述：描述${n}`, '提示词：',
    '```markdown', text, '```', marked ? `<!-- STAGE_END:${n} -->` : '',
].filter(Boolean).join('\n');
let cases = 0;
for (const flags of [[true,true,true], [false,false,false], [true,false,true], [false,true,true], [true,true,false]]) {
    const original = flags.map((flag, i) => stage(i + 1, flag)).join('\n\n') + '\n\n<!-- TRAINING_SCRIPT_COMPLETE -->';
    assert.deepEqual(parseTrainingScript(original).map(s => s.stepName), ['测试1','测试2','测试3']);
    assert.equal(extractScriptStructure(original).stages.length, 3);
    for (let target = 0; target < 3; target++) {
        const updated = replaceStageInScript(original, target, stage(target + 1, false, '已修改'));
        const steps = parseTrainingScript(updated);
        assert.equal(steps.length, 3);
        assert.equal(steps[target].llmPrompt, '已修改');
        for (let i = 0; i < 3; i++) if (i !== target) assert.deepEqual(steps[i], parseTrainingScript(original)[i]);
        assert.equal(extractScriptStructure(updated).stages.length, 3);
        assert.ok(hasTrainingScriptCompleteMarker(updated));
        const twice = replaceStageInScript(updated, target, stage(target + 1, true, '再次修改'));
        assert.equal(parseTrainingScript(twice)[target].llmPrompt, '再次修改');
        assert.equal((twice.match(new RegExp(`<!-- STAGE_START:${target + 1} -->`, 'g')) || []).length, 1);
        cases++;
    }
}
console.log(`Passed ${cases} stage replacement cases, including mixed boundaries and repeated regeneration.`);
