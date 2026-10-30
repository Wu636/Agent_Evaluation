const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const writes = [];
let generations = 0;
const api = {
    queryScriptSteps: async (taskId) => {
        assert.equal(taskId, 'new-task');
        return [{stepId:'new-step', stepDetailDTO:{nodeType:'SCRIPT_NODE',stepName:'当前阶段',llmPrompt:'当前提示词',prologue:'当前开场白',description:'当前描述',avatarNid:'',customDigitalHuman:null,stepExtProperty:{keyVocabularies:[{id:'1',vocabulary:'reservation',explanation:'预订',exampleSentence:'A reservation, please.'}]}},positionDTO:{x:10,y:20}}];
    },
    generateBackgroundImage: async () => { generations++; return {fileId:'image',fileUrl:'image-url'}; },
    editScriptStep: async (...args) => { writes.push(args); return true; },
};
const mod = {exports:{}};
const source = fs.readFileSync(path.join(__dirname,'../app/api/training-inject/regenerate-image/route.ts'),'utf8');
const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
new Function('require','module','exports',js)((id) => {
    if(id === 'next/server') return {NextResponse:{json:(body,options)=>({body,status:options?.status || 200})}};
    if(id.endsWith('/api')) return api;
    throw new Error(`Unexpected runtime dependency: ${id}`);
},mod,mod.exports);
(async () => {
    const payload = {trainTaskId:'new-task',courseId:'new-course',libraryFolderId:'new-folder',credentials:{authorization:'test',cookie:'test'},targetType:'background',stepId:'old-step',stepSnapshot:{llmPrompt:'旧实训提示词',prologue:'旧实训开场白'}};
    const rejected = await mod.exports.POST({json:async()=>payload});
    assert.equal(rejected.status,409);
    assert.equal(writes.length,0);
    assert.equal(generations,0);
    const accepted = await mod.exports.POST({json:async()=>({...payload,stepId:'new-step'})});
    assert.equal(accepted.status,200);
    assert.equal(writes.length,1);
    assert.equal(writes[0][0],'new-task');
    assert.equal(writes[0][1],'new-step');
    assert.equal(writes[0][2].llmPrompt,'当前提示词');
    assert.equal(writes[0][2].prologue,'当前开场白');
    assert.equal(writes[0][2].injectDigitalHuman,false,'image regeneration preserves disabled digital humans');
    assert.equal(writes[0][2].stepExtProperty.keyVocabularies[0].vocabulary,'reservation');
    assert.equal(writes[0][3],'new-course');
    console.log('Passed: foreign stage rejected before generation/write; stale snapshot ignored for current stage.');
})().catch(error=>{console.error(error);process.exitCode=1;});
