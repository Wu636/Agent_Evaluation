import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as imagePreparation from './image-preparation.ts';
import * as imagePreservation from './image-preservation.ts';

function routeHarness({ blockedRubric = false, existing = false, failImage = '', allowWrites = false } = {}) {
  let active=0,peak=0,generated=0,writes=0;
  const bindings=[];
  const generate=async name=>{generated++;peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,4));active--;return name===failImage?null:{fileId:name,fileUrl:`https://mock.invalid/${name}`};};
  const api=new Proxy({
    queryScriptSteps:async()=>[{stepId:'start'},{stepId:'end'}], queryScriptFlows:async()=>[],
    extractStartEndIds:()=>({startId:'start',endId:'end'}),getScriptNodes:()=>existing?[{stepDetailDTO:{stepName:'s0',scriptStepCover:{fileId:'old',fileUrl:'https://mock.invalid/old'}}}]:[],
    queryTrainingTaskConfiguration:async()=>({trainTaskName:'task',description:'desc',trainTaskCover:existing?{fileId:'oldCover',fileUrl:'https://mock.invalid/oldCover'}:null}),
    generateBackgroundImage:async p=>generate(p.stageName),generateCourseCoverImageSource:async()=>generate('cover'),
    editConfiguration:async()=>{if(!allowWrites)throw Error('unexpected write');writes++;return true;},
    deleteScriptStep:async()=>{if(!allowWrites)throw Error('unexpected write');writes++;return true;},
    createScriptStep:async(_task,p)=>{if(!allowWrites)throw Error('unexpected write');writes++;return p.stepName+'-new';},
    editScriptStep:async(_task,_id,p)=>{if(!allowWrites)throw Error('unexpected write');writes++;bindings.push(p);return true;},
    createScriptFlow:async()=>{if(!allowWrites)throw Error('unexpected write');writes++;return true;},
    editScriptStepDetailDTO:async()=>{if(!allowWrites)throw Error('unexpected write');writes++;return true;},
  },{get(o,k){return k in o?o[k]:async()=>{writes++;throw Error('Unexpected platform write: '+String(k));};}});
  const parser={parseTrainingScript:()=>Array.from({length:4},(_,i)=>({stepName:'s'+i,description:'d'+i})),parseRubricMarkdown:()=>[],parseTaskConfig:()=>({trainTaskName:'task',description:'task description'}),parseTrainingScriptFlowConfig:()=>({flowType:'linear'})};
  const src=fs.readFileSync(new URL('../../app/api/training-inject/route.ts',import.meta.url),'utf8');
  const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};
  const require=name=> {
    if(name.endsWith('/image-preparation'))return imagePreparation;
    if(name.endsWith('/image-preservation'))return imagePreservation;
    if(name.endsWith('/api'))return api;
    if(name.endsWith('/parser'))return parser;
    if(name.endsWith('/flow-plan'))return {resolveScriptFlowPlan:()=>[]};
    if(name.endsWith('/layout'))return {planStepLayout:()=>({positions:Array.from({length:4},(_,i)=>({x:i*200,y:300})),startPosition:{x:0,y:300},endPosition:{x:1000,y:300}})};
    if(name.endsWith('/rubric-structured.mjs'))return {resolveRubricFastPath:()=>({ok:false,blocked:blockedRubric})};
    return {};
  };
  vm.runInNewContext(js,{exports,require,TextEncoder,ReadableStream,Response,console:{log(){},warn(){},error(){}}});
  return {POST:exports.POST,bindings,stats:()=>({generated,peak,writes})};
}
test('prepare-only route overlaps cover/background and writes no task or nodes; retry hits scoped cache',async()=>{
  const h=routeHarness();
  const body={trainTaskId:'route-mock-'+Math.random(),courseId:'c',libraryFolderId:'l',credentials:{authorization:'fake',cookie:'fake',userNid:'u'},scriptMarkdown:'mock',imagePrepareOnly:true,imageConcurrency:3};
  const first=await (await h.POST({json:async()=>body})).text();
  assert.match(first,/"type":"complete"/);assert.equal(h.stats().generated,5);assert.equal(h.stats().peak,3);assert.equal(h.stats().writes,0);
  const second=await (await h.POST({json:async()=>body})).text();
  assert.match(second,/cache=hit/);assert.equal(h.stats().generated,5);
  await (await h.POST({json:async()=>({...body,imagePrepareIds:['background:2'],imageRefreshIds:['background:2']})})).text();
  assert.equal(h.stats().generated,6);assert.equal(h.stats().writes,0);
});
test('preserve makes zero generation calls; missing generates only missing backgrounds',async()=>{
 for(const [strategy,expected] of [['preserve',0],['missing',3]]){
 const h=routeHarness({existing:true});const body={trainTaskId:Math.random().toString(),courseId:'c',libraryFolderId:'l',credentials:{authorization:'fake',cookie:'fake'},scriptMarkdown:'mock',imagePrepareOnly:true,imageStrategy:strategy};
 const output=await(await h.POST({json:async()=>body})).text();assert.match(output,/"type":"complete"/);assert.equal(h.stats().generated,expected);assert.equal(h.stats().writes,0);
 }
});
test('fresh rebuild binds preserved background DTO and leaves missing images empty',async()=>{
 const h=routeHarness({existing:true,allowWrites:true});const body={trainTaskId:Math.random().toString(),courseId:'c',libraryFolderId:'l',credentials:{authorization:'fake',cookie:'fake'},scriptMarkdown:'mock',imageStrategy:'preserve',injectDigitalHuman:false};
 const output=await(await h.POST({json:async()=>body})).text();
 assert.match(output,/"type":"complete"/);assert.equal(h.stats().generated,0);assert.equal(h.bindings.length,4);assert.deepEqual(h.bindings[0].scriptStepCover,{fileId:'old',fileUrl:'https://mock.invalid/old'});assert.deepEqual(h.bindings[1].scriptStepCover,{});
});
test('one failed image produces error, never successful preparation completion',async()=>{
 const h=routeHarness({failImage:'s1'});const body={trainTaskId:Math.random().toString(),courseId:'c',libraryFolderId:'l',credentials:{authorization:'fake',cookie:'fake'},scriptMarkdown:'mock',imagePrepareOnly:true};
 const output=await(await h.POST({json:async()=>body})).text();assert.match(output,/"type":"error"/);assert.doesNotMatch(output,/"type":"complete"/);assert.match(output,/background:2/);assert.equal(h.stats().writes,0);
});
test('blocked platform rubric stops before image generation and all writes',async()=>{
 const h=routeHarness({blockedRubric:true});const output=await (await h.POST({json:async()=>({trainTaskId:'t',courseId:'c',libraryFolderId:'l',credentials:{authorization:'fake',cookie:'fake'},scriptMarkdown:'mock',rubricMarkdown:'mock rubric'})})).text();
 assert.match(output,/禁止AI回退/);assert.equal(h.stats().generated,0);assert.equal(h.stats().writes,0);
});
test('invalid image concurrency fails before generation or platform mutation',async()=>{
 const h=routeHarness();const output=await (await h.POST({json:async()=>({trainTaskId:'t',courseId:'c',libraryFolderId:'l',credentials:{authorization:'fake',cookie:'fake'},scriptMarkdown:'mock',imageConcurrency:99})})).text();
 assert.match(output,/"type":"error"/);assert.equal(h.stats().generated,0);assert.equal(h.stats().writes,0);
});
