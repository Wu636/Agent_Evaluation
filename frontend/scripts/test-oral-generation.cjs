const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const loadSource = require('./test-source-loader.cjs').createSourceLoader();
function load(file, deps = {}) {
    const mod = { exports: {} };
    const src = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    new Function('require', 'module', 'exports', src)(id => {
        if (id in deps) return deps[id];
        return loadSource(id);
    }, mod, mod.exports);
    return mod.exports;
}
const config = load('lib/oral-training/config.ts');
const trainingType = 'oral';
assert.equal(config.withOralTrainingContext('教师文档'), '教师文档');
assert.match(config.withOralTrainingContext('教师文档', trainingType), /口语训练生成要求/);
assert.equal(config.parseTrainingType(undefined), 'ability');
const client = load('lib/training-generator/client.ts', { '@/lib/llm/settings': { loadLLMSettingsFromStorage: () => ({ apiUrl: 'https://example.test', apiKey: 'mock' }) } });
let calls = 0;
global.fetch = async (url, init) => {
    const value = init.body instanceof FormData ? init.body.get('trainingType') : JSON.parse(init.body).trainingType;
    assert.equal(value, trainingType, `${url}: oral settings lost`);
    if (!(init.body instanceof FormData)) assert.equal(JSON.parse(init.body).oralSettings, undefined);
    calls++;
    return url === '/api/training-generate'
        ? new Response('data: {"type":"complete"}\n\n')
        : Response.json({ plan: { modules: [] }, stageMarkdown: 'stage', moduleId: 'one', stageIndex: 0 });
};
(async () => {
    for (const file of [undefined, new File(['教师文档'], 'teacher.txt')]) {
        const params = { trainingType, teacherDocName: '任务', teacherDocContent: '文档', file };
        await client.streamTrainingGenerate({ ...params, generateScript: true, generateRubric: true, onEvent: () => {} });
        await client.createTrainingScriptPlan(params);
        await client.regenerateTrainingScriptModule({ ...params, modulePlan: { modules: [] }, targetModuleId: 'one', feedback: '调整', usePreviousResult: true });
    }
    assert.equal(calls, 6);
    // Verify parsed oral context reaches backend planning/module generators, for both request types.
    const seen = [];
    const deps = {
        '@/lib/oral-training/config': config,
        'next/server': { NextResponse: { json: (data, options) => Response.json(data, options) } },
        '@/lib/config': { MODEL_NAME_MAPPING: {} },
        '@/lib/training-generator/generator': {
            planTrainingScriptModules: async doc => { seen.push(doc); return { plan: { modules: [] } }; },
            validateTrainingScriptPlan: () => [],
            regenerateTrainingScriptModule: async doc => { seen.push(doc); return 'stage'; },
        },
        '@/lib/converters/docx-converter': {},
        'word-extractor': class {},
    };
    for (const endpoint of ['plan', 'module-regenerate']) {
        const route = load(`app/api/training-generate/${endpoint}/route.ts`, deps);
        for (const multipart of [false, true]) {
            const payload = { teacherDocContent: '教师文档', apiUrl: 'https://example.test', trainingType, modulePlan: { modules: [{ id: 'one' }] }, targetModuleId: 'one', feedback: '修改' };
            let request;
            if (multipart) {
                const form = new FormData();
                for (const [key, value] of Object.entries(payload)) form.set(key, typeof value === 'object' ? JSON.stringify(value) : value);
                form.set('file', new File(['教师文档'], 'teacher.txt'));
                request = new Request('http://localhost/api', { method: 'POST', body: form });
            } else request = new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });
            const response = await route.POST(request);
            assert.equal(response.status, 200, await response.text());
            assert.match(seen.at(-1), /口语训练生成要求/);
        }
    }
    const mainDeps = { ...deps,
        '@/lib/training-generator/generator': { ...deps['@/lib/training-generator/generator'],
            buildTeacherDocWithPlan: doc => doc,
            generateTrainingRubricStream: async function* (doc) { seen.push(doc); yield '# 评分标准\n口语任务评分'; },
        },
        '@/lib/training-generator/script-tools': {},
        '@/lib/training-injector/parser': { parseRubricMarkdown: () => [{ itemName: '口语', score: 100 }], parseTaskConfig: () => null },
    };
    const main = load('app/api/training-generate/route.ts', mainDeps);
    for (const modeType of ["oral", "ability"]) for (const multipart of [false, true]) {
        const payload = { trainingType: modeType, teacherDocContent: '教师文档', teacherDocName: '任务', generateScript: false, generateRubric: true, apiKey: 'mock', apiUrl: 'https://example.test' };
        let request;
        if (multipart) {
            const form = new FormData();
            for (const [key, value] of Object.entries(payload)) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
            form.set('file', new File(['教师文档'], 'teacher.txt'));
            request = new Request('http://localhost/api', { method: 'POST', body: form });
        } else request = new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });
        const before = seen.length;
        const response = await main.POST(request);
        const events = (await response.text()).split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
        if (modeType === 'oral') {
            assert.match(events.find(e => e.type === 'error')?.message || '', /暂不支持生成评分标准/);
            assert.equal(seen.length, before, 'oral rubric must not invoke the generator');
        } else {
            assert.equal(events.some(e => e.type === 'error'), false, JSON.stringify(events));
            assert.equal(events.some(e => e.type === 'complete'), true);
            assert.equal(seen.at(-1), '教师文档');
        }
    }
    console.log('PASS: oral settings on 6 client paths and 6 backend file/text generation, planning, module paths; ability default unchanged.');
})().catch(e => { console.error(e); process.exitCode = 1; });
