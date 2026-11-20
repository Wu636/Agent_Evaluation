import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const sharedUrl = new URL('../training-injector/image-preparation.ts', import.meta.url).href;
const source = fs.readFileSync(new URL('./image-preparation.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace('../training-injector/image-preparation', sharedUrl);
const {buildProImageJobs,prepareProImages,retainedProImages} = await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const plan = {global:{abilityName:'training',description:'desc',coverImageDescription:'cover'},stages:Array.from({length:5},(_,i)=>({cardName:`stage${i}`,backgroundImageDescription:`background${i}`})),options:{injectCoverImage:true,injectBackgroundImage:true,coverStylePrompt:'wide',backgroundStylePrompt:'wide',imageProviderMode:'openai',imageModel:'mock'}};
const pause = ms => new Promise(r=>setTimeout(r,ms));

test('Pro prepares cover/background together at default three; caller writes nodes in order',async()=>{
 let active=0,peak=0; const writes=[];
 const batch=prepareProImages(plan, async p=>{peak=Math.max(peak,++active);await pause(p.stageName==='stage0'?15:3);active--;return {fileId:p.stageName,fileUrl:'https://mock.invalid/'+encodeURIComponent(p.stageName)};},{scope:'pro-order',cacheMode:'off'});
 assert.equal(batch.results.size,6);
 for(let i=0;i<5;i++) {const r=await batch.results.get(`background:${i}`);writes.push(r.image.fileId);}
 await batch.done;assert.equal(peak,3);assert.deepEqual(writes,['stage0','stage1','stage2','stage3','stage4']);
});
test('failure independent; successful cache reused and model/style changes invalidate',async()=>{
 let calls=0;const generate=async p=>{calls++;return p.stageName==='stage1'?null:{fileId:p.stageName,fileUrl:'https://mock.invalid/image'};};
 const first=await prepareProImages(plan,generate,{scope:'pro-cache'}).done;assert.equal(first.filter(r=>r.failed).length,1);assert.equal(calls,6);
 await prepareProImages(plan,generate,{scope:'pro-cache'}).done;assert.equal(calls,7);
 await prepareProImages({...plan,options:{...plan.options,imageModel:'different'}},generate,{scope:'pro-cache'}).done;assert.equal(calls,13);
});
test('disabled/empty images produce no jobs; uploaded ID required; requests isolated',async()=>{
 assert.equal(buildProImageJobs({...plan,options:{...plan.options,injectCoverImage:false,injectBackgroundImage:false}},async()=>null).length,0);
 let calls=0;const generate=async()=>{calls++;return {fileUrl:'https://temporary.invalid/image'};};
 await prepareProImages(plan,generate,{scope:'pro-temp'}).done;await prepareProImages(plan,generate,{scope:'pro-temp'}).done;assert.equal(calls,12);
});
test('preserve retains exact known URLs, missing generates only gaps, unknown DTOs fail closed',async()=>{
 const task={trainTaskCover:'https://platform.invalid/cover'};
 const rows=[{stepName:'stage0',extConfig:{bgMediaType:1,bgMedia:'https://platform.invalid/bg'}},{stepName:'stage1',extConfig:{bgMediaType:1,bgMedia:null}}];
 const retained=retainedProImages(task,rows,plan.stages);assert.equal(retained.get('background:0'),'https://platform.invalid/bg');
 let calls=0;const gen=async()=>{calls++;return null;};
 await prepareProImages({...plan,strategy:'preserve',retained},gen,{scope:'preserved'}).done;assert.equal(calls,0);
 const missing=buildProImageJobs({...plan,strategy:'missing',retained},gen);assert.deepEqual(missing.map(j=>j.id),['background:1','background:2','background:3','background:4']);
 assert.throws(()=>retainedProImages({},rows,plan.stages),/trainTaskCover/);
 assert.throws(()=>retainedProImages(task,[...rows,rows[0]],plan.stages),/同名/);
 assert.throws(()=>retainedProImages(task,[{stepName:'stage0'}],plan.stages),/bgMedia/);
 assert.throws(()=>retainedProImages(task,[{stepName:'stage0',extConfig:{bgMediaType:2,bgMedia:'https://platform.invalid/video'}}],plan.stages),/图片类型/);
 assert.throws(()=>retainedProImages(task,rows,[plan.stages[0],plan.stages[0]]),/唯一/);
 const empty=retainedProImages({trainTaskCover:null},[],plan.stages);assert.equal(empty.size,0);
});

test('route uses prepared images while createStage remains ordered; no temporary URL fallback',()=>{
 const route=fs.readFileSync(new URL('../../app/api/training-inject-pro/route.ts',import.meta.url),'utf8');
 assert.match(route,/imagePreparation\.results\.get\("cover"\)/);assert.match(route,/imagePreparation\.results\.get\(`background:\$\{index\}`\)/);
 assert.match(route,/for \(let index = 0; index < stages\.length; index\+\+\)/);assert.match(route,/const stageId = await createStage/);
 assert.doesNotMatch(route,/\|\| generated;/);assert.doesNotMatch(route,/"sk-[A-Za-z0-9]+"/);
 assert.match(route,/await imagePreparation\?\.done/);
});
