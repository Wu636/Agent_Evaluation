const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('components/InjectConfigModal.tsx', 'utf8');
const start = source.indexOf('    // Overrides belong');
const end = source.indexOf('    // 计算最终生效', start);
assert.ok(start >= 0 && end > start);
const effect = source.slice(start, end);
function scenario(nextScript, nextRubric) {
    const state = { script: 'edited old script', rubric: 'edited old rubric', combined: 'old combined', summary: {} };
    const context = {
        scriptMarkdown: nextScript, rubricMarkdown: nextRubric,
        generatedScriptMirrorRef: { current: 'old script' },
        generatedRubricMirrorRef: { current: 'old rubric' },
        useEffect: fn => fn(),
        setCustomScriptText: value => state.script = value,
        setCustomRubricText: value => state.rubric = value,
        setCustomCombinedText: value => state.combined = value,
        setSummary: value => state.summary = value,
        setCustomDocMode: value => state.mode = value,
        setCustomDocExpanded: value => state.expanded = value,
        setSourceSyncMessage: value => state.message = value,
    };
    vm.runInNewContext(effect, context);
    return { state, context };
}
const scriptUpdate = scenario('saved new script', 'old rubric');
assert.equal(scriptUpdate.state.script, '');
assert.equal(scriptUpdate.state.rubric, 'edited old rubric');
assert.equal(scriptUpdate.state.combined, '');
assert.equal(scriptUpdate.context.generatedScriptMirrorRef.current, 'saved new script');
const rubricUpdate = scenario('old script', 'saved new rubric');
assert.equal(rubricUpdate.state.rubric, '');
assert.equal(rubricUpdate.state.script, 'edited old script');
assert.equal(rubricUpdate.state.combined, '');
const unchanged = scenario('old script', 'old rubric');
assert.equal(unchanged.state.script, 'edited old script');
assert.equal(unchanged.state.combined, 'old combined');
// Reopening/rerendering with the same revision preserves newly made overrides.
scriptUpdate.state.script = 'edited new script';
vm.runInNewContext(effect, scriptUpdate.context);
assert.equal(scriptUpdate.state.script, 'edited new script');
assert.equal(scenario('', '').state.script, '');
console.log('Injection source sync regression checks passed.');
