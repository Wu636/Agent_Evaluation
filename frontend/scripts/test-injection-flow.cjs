const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const loadSource = require('./test-source-loader.cjs').createSourceLoader();
const stages = [1, 2].map(n => ({ stepName: `阶段${n}`, description: `描述${n}`, prologue: `开场白${n}`, llmPrompt: `提示词${n}`, trainerName: '导师', interactiveRounds: 3, scriptStepCover: {} }));
async function run(flag, mode) {
    const calls = [];
    let id = 0;
    const api = {
        queryScriptSteps: async () => [
            { stepId: "start", stepDetailDTO: { nodeType: "SCRIPT_START" }, positionDTO: { x: 0, y: 0 } },
            { stepId: "end", stepDetailDTO: { nodeType: "SCRIPT_END" }, positionDTO: { x: 1200, y: 0 } },
        ], queryScriptFlows: async () => [],
        editScriptStepDetailDTO: async () => true,
        extractStartEndIds: () => ({ startId: 'start', endId: 'end' }), getScriptNodes: () => [],
        queryTrainingTaskConfiguration: async () => null,
        listOwnerVoiceTrainings: async () => { calls.push(['voices']); return []; },
        listOwnerDigitalHumans: async () => { calls.push(['humans']); return []; },
        createCustomDigitalHuman: async () => { calls.push(['human']); return 'human'; },
        createScriptStep: async (_, data) => { calls.push(['create', data]); return `node${++id}`; },
        editScriptStep: async (_, stepId, data) => { calls.push(['edit', data]); return true; },
        createScriptFlow: async (...args) => { calls.push(['flow', args]); return 'flow'; },
        createScoreItem: async () => { calls.push(['score']); return { itemId: 'score' }; },
    };
    const parser = {
        parseTrainingScript: () => stages,
        parseTaskConfig: () => null,
        parseTrainingScriptFlowConfig: () => ({ flowType: 'linear', edges: [] }),
        parseRubricMarkdown: () => [{ itemName: '评分', score: 100 }],
    };
    const voice = new Proxy({}, { get: (_, name) => {
        if (String(name).startsWith('is')) return () => true;
        if (name === 'toVoiceCandidates') return () => [];
        if (name === 'selectBestVoiceCandidate') return () => null;
        if (String(name).includes('AgeGroup')) return () => 'adult';
        return () => 'male';
    }});
    const source = ts.transpileModule(fs.readFileSync('app/api/training-inject/route.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', source)(name => {
        if (name.endsWith('/parser')) return parser;
        if (name.endsWith('/api')) return api;
        if (name.endsWith('/voice-selection')) return voice;
        if (name.endsWith('/llm-extractor') || name === 'next/server') return {};
        return loadSource(name);
    }, mod, mod.exports);
    const response = await mod.exports.POST({ json: async () => ({
        trainTaskId: 'task', courseId: 'course', libraryFolderId: 'folder',
        credentials: { authorization: 'test', cookie: 'test' }, extractionMode: 'regex',
        scriptMarkdown: 'script', rubricMarkdown: 'rubric', injectMode: mode,
        injectCoverImage: false, injectBackgroundImage: false, injectDigitalHuman: flag,
    }) });
    const events = (await response.text()).split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
    assert.equal(events.find(e => e.type === 'error'), undefined, JSON.stringify(events));
    assert.equal(calls.filter(c => c[0] === 'create').length, 2, `digitalHuman=${flag}, mode=${mode}: stages skipped`);
    assert.equal(calls.filter(c => c[0] === 'edit').length, 2);
    assert.equal(calls.filter(c => c[0] === 'flow').length, 3);
    assert.equal(calls.filter(c => c[0] === 'score').length, 1);
    assert.deepEqual(events.find(e => e.type === 'complete').summary, { stepsCreated: 2, flowsCreated: 3, scoreItemsCreated: 1, stepsDeleted: 0, flowsDeleted: 0 });
    for (const [, data] of calls.filter(c => ['create', 'edit'].includes(c[0]))) {
        assert.equal(data.injectDigitalHuman, flag);
        assert.ok(data.llmPrompt.startsWith('提示词'));
    }
    if (!flag) assert.equal(calls.filter(c => ['voices', 'humans', 'human'].includes(c[0])).length, 0);
}
(async () => {
    for (const flag of [false, true]) for (const mode of ['replace', 'append']) await run(flag, mode);
    console.log('Passed 4 route scenarios: digital human on/off, replace/append; stages, configuration, flows and rubric.');
})().catch(error => { console.error(error); process.exitCode = 1; });
