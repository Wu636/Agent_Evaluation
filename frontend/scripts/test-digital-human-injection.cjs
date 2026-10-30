const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const cache = new Map();
function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} };
    cache.set(file, mod);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    new Function('require', 'module', 'exports', source)((id) => id.startsWith('.')
        ? load(path.resolve(path.dirname(file), id) + '.ts') : require(id), mod, mod.exports);
    return mod.exports;
}
const requests = [];
global.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    requests.push(payload);
    assert.ok(payload.stepDetailDTO.agentId, '节点语音引擎不可清空');
    assert.ok(payload.stepDetailDTO.agentVoiceId, '节点音色不可清空');
    return { ok: true, json: async () => ({ code: 200 }) };
};
const { createScriptStep, editScriptStep } = load(path.resolve('lib/training-injector/api.ts'));
(async () => {
    const credentials = { authorization: 'test', cookie: 'test' };
    const stage = { stepName: '阶段一', description: '描述', prologue: '开场白',
        modelId: 'test', llmPrompt: '提示词', trainerName: '导师', interactiveRounds: 3,
        agentId: '', agentVoiceId: '', avatarNid: 'avatar', customDigitalHuman: 'custom', scriptStepCover: {} };
    for (const flag of [false, true, undefined]) {
        const input = { ...stage, injectDigitalHuman: flag };
        const stepId = await createScriptStep('task', input, { x: 0, y: 0 }, credentials);
        assert.ok(stepId);
        assert.equal(await editScriptStep('task', stepId, input, 'course', 'folder', { x: 0, y: 0 }, credentials), true);
        for (const payload of requests.slice(-2)) {
            const dto = payload.stepDetailDTO;
            assert.equal(dto.avatarNid, flag === false ? '' : 'avatar');
            assert.equal(dto.customDigitalHuman, flag === false ? null : 'custom');
            for (const key of ['stepName', 'description', 'llmPrompt', 'prologue', 'interactiveRounds']) assert.equal(dto[key], stage[key]);
        }
    }
    console.log('Passed 6 mocked create/edit requests: digital human off, on, and legacy default.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
