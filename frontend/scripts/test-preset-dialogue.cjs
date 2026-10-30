const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const load = require('./test-source-loader.cjs').createSourceLoader();
const dialogue = load('@/lib/training-generator-pro/dialogue');
const config = {
    globalConfig: { taskName: '情境练习' },
    members: [{ memberName: 'Teacher', roleDescription: '导师', skills: [] }],
    stages: [1, 2].map(n => ({ cardName: `Stage ${n}`, cardDescription: '完成对话任务',
        userRoleName: 'Student', userRoleDescription: '学生', userAssignName: '同学', scriptPrompt: '循序引导，完成任务后再通关。' })),
};
const messages = [{ role: 'assistant', speaker: 'Teacher', content: 'Hello!' },
    { role: 'user', speaker: 'Student', content: 'Hello, teacher.' }];
assert.deepEqual(dialogue.normalizePresetMessages({ messages }, ['Teacher', 'Student']), messages);
assert.throws(() => dialogue.normalizePresetMessages({ messages: messages.slice().reverse() }, ['Teacher', 'Student']), /智能体/);
assert.throws(() => dialogue.normalizePresetMessages({ messages: [{ ...messages[0], speaker: 'Unknown' }, messages[1]] }, ['Teacher', 'Student']), /无效角色/);
assert.notEqual(dialogue.getConfigFingerprint('old script'), dialogue.getConfigFingerprint('new script'));
const calls = [];
let rejectSecondStage = false;
const deps = {
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@/lib/config': { MODEL_NAME_MAPPING: {} },
    '@/lib/training-injector-pro/parser': { parseProMarkdown: () => config },
    '@/lib/llm/utils': { callLLM: async prompt => {
        calls.push(prompt);
        if (rejectSecondStage && prompt.includes('阶段名称：Stage 2')) throw new Error('fixture stage failure');
        // A broken first stage response is retried before the next stage runs.
        return calls.length === 1 ? '{"messages":[]}' : JSON.stringify({ messages });
    } },
};
const mod = { exports: {} };
const source = ts.transpileModule(fs.readFileSync('app/api/training-generate-pro/dialogue/route.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
new Function('require', 'module', 'exports', source)(id => deps[id] || load(id), mod, mod.exports);
(async () => {
    const request = payload => ({ json: async () => payload });
    const response = await mod.exports.POST(request({ markdown: 'script', apiKey: 'fixture', apiUrl: 'https://fixture.invalid', performance: 'excellent' }));
    const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.equal(events.some(event => event.type === 'error'), false);
    assert.equal(events.filter(event => event.type === 'stage_complete').length, 2);
    assert.equal(events.at(-1).type, 'complete');
    assert.equal(events.at(-1).stages.length, 2);
    assert.equal(events.at(-1).configFingerprint, dialogue.getConfigFingerprint('script'));
    assert.equal(calls.length, 3);
    assert.match(calls[1], /此前本阶段输出未通过/);
    assert.match(calls[2], /Stage 1已完成/);
    assert.match(dialogue.renderPresetDialogue(events.at(-1)), /\*\*Teacher：\*\* Hello!/);
    const invalid = await mod.exports.POST(request({ markdown: 'script', stageIndexes: [99] }));
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, 3, 'invalid stages do not call the model');
    rejectSecondStage = true;
    const partialResponse = await mod.exports.POST(request({ markdown: 'script' }));
    const partialEvents = (await partialResponse.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.equal(partialEvents.at(-1).type, 'error');
    assert.equal(partialEvents.at(-1).partialStages.length, 1, 'completed stages survive a later stage failure');
    assert.equal(partialEvents.filter(event => event.type === 'stage_complete').length, 1);
    console.log('PASS: preset dialogue roles, retry, stage continuity, streamed completion, fingerprint and invalid selection.');
})().catch(error => { console.error(error); process.exitCode = 1; });
