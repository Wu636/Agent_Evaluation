import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImages, imagePreparationScope } from './image-preparation.ts';
const delay = ms => new Promise(r => setTimeout(r, ms));
const image = id => ({fileId:id,fileUrl:`https://mock.invalid/${id}.png`});
const scope = () => imagePreparationScope({courseId:'c',taskId:Math.random().toString(),authorization:'fake',cookie:'fake'});

test('bounded preparation overlaps images and returns stable per-ID results', async () => {
  let active=0, peak=0;
  const jobs=Array.from({length:7},(_,i)=>({id:String(i),fingerprint:{i},generate:async()=>{peak=Math.max(peak,++active);await delay(5);active--;return image(String(i));}}));
  const batch=prepareImages(jobs,{scope:scope(),concurrency:3});
  const results=await batch.done;
  assert.equal(peak,3); assert.equal(results.length,7); assert.equal((await batch.results.get('4')).image.fileId,'4');
});
test('successful assets reuse cache; only failed asset is generated on retry', async()=>{
  const s=scope();let a=0,b=0;
  const jobs=[{id:'a',fingerprint:{v:1},generate:async()=>{a++;return image('a');}},{id:'b',fingerprint:{v:1},generate:async()=>{b++;return b===1?null:image('b');}}];
  assert.equal((await prepareImages(jobs,{scope:s}).done)[1].failed,true);
  const results=await prepareImages(jobs,{scope:s}).done;
  assert.equal(a,1);assert.equal(b,2);assert.equal(results[0].cache,'hit');
  await prepareImages(jobs,{scope:s,refreshIds:['b']}).done;
  assert.equal(a,1);assert.equal(b,3);
});
test('scope distinguishes task/course/session/provider credentials without leaking them',()=>{
  const input={userId:'u',courseId:'c',taskId:'t',authorization:'secret-token',cookie:'secret-cookie'};
  const s=imagePreparationScope(input);assert.equal(s,imagePreparationScope(input));assert.match(s,/^[a-f0-9]{64}$/);
  for(const [key,value] of Object.entries({userId:'v',courseId:'d',taskId:'x',authorization:'new',cookie:'new',generationKey:'new'})) assert.notEqual(s,imagePreparationScope({...input,[key]:value}));
  assert.equal(imagePreparationScope({...input,userId:''}),imagePreparationScope({...input,userId:''}));
  assert.notEqual(imagePreparationScope({...input,userId:'',authorization:'',cookie:''}),imagePreparationScope({...input,userId:'',authorization:'',cookie:''}));
});
test('input change invalidates; off disables reuse; concurrent identical requests coalesce',async()=>{
  let calls=0; const s=scope();const jobs=[{id:'cover',fingerprint:{v:1},generate:async()=>{calls++;await delay(5);return image('c');}}];
  const a=prepareImages(jobs,{scope:s}),b=prepareImages(jobs,{scope:s});await Promise.all([a.done,b.done]);assert.equal(calls,1);
  await prepareImages([{...jobs[0],fingerprint:{v:2}}],{scope:s}).done;assert.equal(calls,2);
  await prepareImages(jobs,{scope:s,cacheMode:'off'}).done;assert.equal(calls,3);
});
test('validation fails before generators; failures are isolated and sanitized',async()=>{
 let calls=0;const job={id:'x',fingerprint:{},generate:async()=>{calls++;throw new Error('secret');}};
 assert.throws(()=>prepareImages([job],{scope:scope(),concurrency:0}));assert.equal(calls,0);
 assert.throws(()=>prepareImages([job,job],{scope:scope()}));assert.throws(()=>prepareImages([job],{scope:scope(),refreshIds:['bad']}));
 const r=await prepareImages([job,{id:'y',fingerprint:{},generate:async()=>image('y')}],{scope:scope()}).done;
 assert.equal(r[0].failed,true);assert.equal(r[1].failed,false);assert.equal(JSON.stringify(r).includes('secret'),false);
});
