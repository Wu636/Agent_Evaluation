const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const loadSource = require('./test-source-loader.cjs').createSourceLoader();
const vocabMod = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync('lib/oral-training/vocabulary.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(require, vocabMod, vocabMod.exports);
const stages = [1, 2].map(n => ({ keyVocabularies: [{ term: `word${n}`, meaning: `释义${n}`, exampleSentence: `Example ${n}`, source: `文档${n}` }], stepName: `阶段${n}`, description: `描述${n}`, prologue: `开场白${n}`, llmPrompt: `提示词${n}`, trainerName: '导师', interactiveRounds: 3, scriptStepCover: {} }));
async function run(flag, mode, selected = [1], enabled = true) {
    const calls = [];
    let id = 0;
    const api = {
        queryScriptSteps: async () => [
            { stepId: "start", stepDetailDTO: { nodeType: "SCRIPT_START" }, positionDTO: { x: 0, y: 0 } },
            { stepId: "end", stepDetailDTO: { nodeType: "SCRIPT_END" }, positionDTO: { x: 1200, y: 0 } },
        ], queryScriptFlows: async () => [],
        editScriptStepDetailDTO: async () => true,
        extractStartEndIds: () => ({ startId: 'start', endId: 'end' }), getScriptNodes: () => [],
        queryTrainingTaskConfiguration: async () => ({ raw: { trainSubType: "oral", extConfig: { dialogueLanguage: "en" } } }),
        toPlatformVocabularies: vocabMod.exports.toPlatformVocabularies,
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
        credentials: { authorization: 'test', cookie: 'test', trainSubType: 'oral' }, extractionMode: 'regex',
        scriptMarkdown: 'script', rubricMarkdown: 'rubric', injectMode: mode, injectKeyVocabularies: enabled, vocabularyStageIndexes: selected,
        injectCoverImage: false, injectBackgroundImage: false, injectDigitalHuman: flag,
    }) });
    const events = (await response.text()).split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
    if (enabled && selected.some(i => i >= stages.length)) {
        assert.ok(events.find(e => e.type === 'error'));
        assert.equal(calls.length, 0, 'invalid stage selection must stop before mutations');
        return;
    }
    assert.equal(events.find(e => e.type === 'error'), undefined, JSON.stringify(events));
    assert.equal(calls.filter(c => c[0] === 'create').length, 2, `digitalHuman=${flag}, mode=${mode}: stages skipped`);
    assert.equal(calls.filter(c => c[0] === 'edit').length, 2);
    assert.equal(calls.filter(c => c[0] === 'flow').length, 3);
    assert.equal(calls.filter(c => c[0] === 'score').length, 0);
    assert.deepEqual(events.find(e => e.type === 'complete').summary, { stepsCreated: 2, flowsCreated: 3, scoreItemsCreated: 0, stepsDeleted: 0, flowsDeleted: 0 });
    for (const [, data] of calls.filter(c => ['create', 'edit'].includes(c[0]))) {
        assert.equal(data.injectDigitalHuman, flag);
        assert.ok(data.llmPrompt.startsWith('提示词'));
    }
    const created = calls.filter(c => c[0] === 'create').map(c => c[1]);
    const edited = calls.filter(c => c[0] === 'edit').map(c => c[1]);
    for (let i = 0; i < 2; i++) {
        const words = created[i].stepExtProperty.keyVocabularies;
        assert.equal(words.length, enabled && selected.includes(i) ? 1 : 0);
        if (words.length) {
            assert.equal(words[0].vocabulary, `word${i+1}`);
            assert.equal(words[0].exampleSentence, `Example ${i+1}`);
        }
        assert.deepEqual(edited[i].stepExtProperty.keyVocabularies, words, 'create and edit must reuse the same IDs and content');
    }
    if (!flag) assert.equal(calls.filter(c => ['voices', 'humans', 'human'].includes(c[0])).length, 0);
}
(async () => {
    for (const flag of [false, true]) for (const mode of ['replace', 'append']) await run(flag, mode);
    await run(false, 'replace', [99], true);
    await run(false, 'replace', [], true);
    await run(false, 'replace', [0, 1], false);
    await run(false, 'replace', [0, 1], true);
    console.log('PASS: per-stage vocabulary selection, select none/all, master switch off, replace/append, stable IDs across create/edit.');
})().catch(error => { console.error(error); process.exitCode = 1; });
