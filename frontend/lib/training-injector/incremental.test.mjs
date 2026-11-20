import test from 'node:test';
import assert from 'node:assert/strict';
import { planIncremental, applyIncremental, fingerprint, resourcePreservingDetail, restoreResources, fullSnapshotFingerprint, normalizeControlTokens, planControlTokenNormalization } from './incremental.ts';
const fixture=()=>({trainTaskId:'t',type:'ability',steps:[{stepId:'s',positionDTO:{x:0,y:0},stepDetailDTO:{nodeType:'SCRIPT_NODE',stepName:'A',llmPrompt:'old',prologue:'hello',description:'desc',scriptStepResourceList:[{fileId:'keep'}],stepExtProperty:{background:'keep'},agentId:'keep'}}],flows:[{flowId:'f',scriptStepStartId:'s',scriptStepEndId:'s'}]});
test('unchanged never writes and no fields lost on content-only patch',async()=>{
 let current=fixture(),writes=0;
 const io={read:async()=>structuredClone(current),edit:async step=>{writes++; assert.equal(step.stepDetailDTO.agentId,'keep');assert.deepEqual(step.positionDTO,{x:0,y:0});current.steps[0]=step;return true;}};
 assert.equal((await applyIncremental(current,current,io,true)).success,true);assert.equal(writes,0);
 const base=structuredClone(current),desired=structuredClone(base);desired.steps[0].stepDetailDTO.llmPrompt='new';
 assert.equal((await applyIncremental(base,desired,io,true)).success,true);assert.equal(writes,1);assert.equal(current.steps[0].stepDetailDTO.scriptStepResourceList[0].fileId,'keep');
});
test('topology/nontext/current conflict rejected before writes',async()=>{
 const base=fixture(),desired=fixture();desired.flows[0].flowId='other';assert.throws(()=>planIncremental(base,desired));
 desired.flows=base.flows;desired.steps[0].stepDetailDTO.agentId='new';assert.throws(()=>planIncremental(base,desired));
 let writes=0;const fresh=fixture();fresh.steps[0].stepDetailDTO.description='teacher change';await assert.rejects(applyIncremental(base,base,{read:async()=>fresh,edit:async()=>{writes++;return true;}},true),/CONFLICT/);assert.equal(writes,0);
});
test('readback failure after write retains applied evidence',async()=>{
 const base=fixture(),desired=fixture();desired.steps[0].stepDetailDTO.llmPrompt='new';let reads=0;
 const result=await applyIncremental(base,desired,{read:async()=>{if(++reads===3)throw Error('transport');return structuredClone(base);},edit:async()=>true},true);
 assert.equal(result.success,false);assert.deepEqual(result.applied,['s']);assert.equal(result.reason,'readback-unavailable');
});
test('server updateTime changes allow multiple writes and final verification without mutating snapshots',async()=>{
 const base=fixture();base.steps[0].stepDetailDTO.updateTime='old timestamp';
 base.steps.push({...structuredClone(base.steps[0]),stepId:'b',stepDetailDTO:{...structuredClone(base.steps[0].stepDetailDTO),stepName:'B'}});
 const desired=structuredClone(base);desired.steps.forEach(s=>s.stepDetailDTO.llmPrompt='new');
 let current=structuredClone(base),writes=0;
 const result=await applyIncremental(base,desired,{read:async()=>structuredClone(current),edit:async step=>{
  writes++;step.stepDetailDTO.updateTime=`server timestamp ${writes}`;
  current.steps=current.steps.map(s=>s.stepId===step.stepId?step:s);return true;
 }},true);
 assert.equal(result.success,true);assert.equal(result.verified,true);assert.equal(writes,2);assert.deepEqual(result.applied,['s','b']);
 assert.equal(base.steps[0].stepDetailDTO.updateTime,'old timestamp');assert.equal(desired.steps[0].stepDetailDTO.updateTime,'old timestamp');
});
test('only stepDetailDTO.updateTime is ignored and metadata cannot be edited through plan',()=>{
 const base=fixture(),metadata=structuredClone(base);metadata.steps[0].stepDetailDTO.updateTime='server time';
 assert.equal(fingerprint(base),fingerprint(metadata));assert.throws(()=>planIncremental(base,metadata));
 for(const mutate of [
  s=>{s.steps[0].stepDetailDTO.description='changed';},
  s=>{s.steps[0].stepDetailDTO.createTime='changed';},
  s=>{s.steps[0].updateTime='changed';},
  s=>{s.steps[0].stepDetailDTO.stepExtProperty.updateTime='changed';},
  s=>{s.steps[0].stepDetailDTO.scriptStepResourceList[0].updateTime='changed';},
  s=>{s.flows[0].updateTime='changed';},
  s=>{s.steps[0].positionDTO.x=1;}
 ]){const changed=structuredClone(base);mutate(changed);assert.notEqual(fingerprint(base),fingerprint(changed));}
});
test('business changes between writes remain conflicts even with server timestamps',async()=>{
 const base=fixture();base.steps.push({...structuredClone(base.steps[0]),stepId:'b',stepDetailDTO:{...structuredClone(base.steps[0].stepDetailDTO),stepName:'B'}});
 const desired=structuredClone(base);desired.steps.forEach(s=>s.stepDetailDTO.llmPrompt='new');let current=structuredClone(base),writes=0;
 const result=await applyIncremental(base,desired,{read:async()=>structuredClone(current),edit:async step=>{
  writes++;current.steps[0]=step;current.steps[0].stepDetailDTO.updateTime='server time';current.steps[1].stepDetailDTO.description='concurrent teacher edit';return true;
 }},true);
 assert.equal(result.success,false);assert.equal(result.reason,'post-write-mismatch');assert.equal(result.failedStepId,'s');assert.deepEqual(result.applied,['s']);assert.equal(writes,1);
});
test('write adapter preserves all resource IDs, duplicates, placeholders and metadata',async()=>{
 const base=fixture();const d=base.steps[0].stepDetailDTO;
 d.scriptStepResourceList=[{scriptStepResourceId:'placeholder',fileId:null,resourceTypeNid:'default',category:'未分类',sort:null},...['one','two'].map((id,i)=>({scriptStepResourceId:id,fileId:'same-file',resourceTypeNid:'default',category:'未分类',sort:i+1,isRequired:0,description:'keep',custom:{key:'keep'}}))];
 d.stepExtProperty={resources:null,background:'keep'};
 const original=structuredClone(base),desired=structuredClone(base);desired.steps[0].stepDetailDTO.llmPrompt='new';
 let current=structuredClone(base);
 const result=await applyIncremental(base,desired,{read:async()=>structuredClone(current),edit:async step=>{
  const payload=resourcePreservingDetail(step.stepDetailDTO);
  assert.deepEqual(payload.stepExtProperty.resources[0].list,d.scriptStepResourceList);
  // Platform reads flat but saves nested; an absent nested list loses resources.
  step.stepDetailDTO.scriptStepResourceList=payload.stepExtProperty.resources.flatMap(g=>g.list);
  current.steps[0]=step;return true;
 }},true);
 assert.equal(result.success,true);assert.deepEqual(base,original);
 const inconsistent=structuredClone(d);inconsistent.stepExtProperty.resources=[];
 assert.throws(()=>resourcePreservingDetail(inconsistent),/不一致/);
 const unknown=structuredClone(d);delete unknown.scriptStepResourceList[0].category;
 assert.throws(()=>resourcePreservingDetail(unknown),/分类缺失/);
});
test('strict empty placeholder writes an empty group and roundtrips server flat placeholder',()=>{
 const detail={scriptStepResourceList:[{resourceTypeNid:'default',category:'未分类',fileId:null,scriptStepResourceId:null}],stepExtProperty:{resources:null}};
 const payload=resourcePreservingDetail(detail); assert.deepEqual(payload.stepExtProperty.resources,[{nid:'default',category:'未分类',list:[]}]);
 const server={...detail,stepExtProperty:{...detail.stepExtProperty,resources:payload.stepExtProperty.resources},scriptStepResourceList:[{resourceTypeNid:'default',category:'未分类',fileId:null,scriptStepResourceId:null}]};
 assert.deepEqual(resourcePreservingDetail(server).stepExtProperty.resources,payload.stepExtProperty.resources);
 const unknown={...detail,scriptStepResourceList:[{resourceTypeNid:'default',category:'未分类',fileId:null,extra:'reject'}]}; assert.throws(()=>resourcePreservingDetail(unknown),/空占位包含未知字段/);
});
test('resource loss is detected immediately on the written node, without another write',async()=>{
 const base=fixture();base.steps.push({...structuredClone(base.steps[0]),stepId:'b'});
 const desired=structuredClone(base);desired.steps.forEach(s=>s.stepDetailDTO.llmPrompt='new');let current=structuredClone(base),writes=0;
 const result=await applyIncremental(base,desired,{read:async()=>structuredClone(current),edit:async step=>{writes++;step.stepDetailDTO.scriptStepResourceList=[];current.steps[0]=step;return true;}},true);
 assert.equal(result.reason,'post-write-mismatch');assert.equal(result.failedStepId,'s');assert.deepEqual(result.applied,['s']);assert.equal(writes,1);
});
test('explicit restore retains current prompt and every original binding, exact precondition enforced',async()=>{
 const original=fixture();original.steps[0].stepDetailDTO.scriptStepResourceList=[{scriptStepResourceId:'id',fileId:'file',resourceTypeNid:'default',category:'未分类',custom:'keep'}];original.steps[0].stepDetailDTO.stepExtProperty.resources=null;
 const expected=structuredClone(original);expected.steps[0].stepDetailDTO.llmPrompt='already updated';expected.steps[0].stepDetailDTO.scriptStepResourceList=[];
 const hash=fullSnapshotFingerprint(expected);let current=structuredClone(expected),writes=0;
 const io={read:async()=>structuredClone(current),edit:async step=>{writes++;assert.equal(step.stepDetailDTO.llmPrompt,'already updated');step.stepDetailDTO.scriptStepResourceList=step.stepDetailDTO.stepExtProperty.resources.flatMap(g=>g.list);step.stepDetailDTO.stepExtProperty.resources=null;step.stepDetailDTO.updateTime='new';current.steps[0]=step;return true;}};
 const result=await restoreResources(expected,original,'s',hash,io);assert.equal(result.success,true);assert.equal(writes,1);assert.deepEqual(current.steps[0].stepDetailDTO.scriptStepResourceList,original.steps[0].stepDetailDTO.scriptStepResourceList);
 await assert.rejects(restoreResources(expected,original,'s',hash,io),/CONFLICT/);assert.equal(writes,1);
 const changed=structuredClone(original);changed.steps[0].stepDetailDTO.agentId='other';await assert.rejects(restoreResources(expected,changed,'s',hash,io),/范围外/);assert.equal(writes,1);
 await assert.rejects(restoreResources(expected,original,'s','incorrect',io),/指纹/);assert.equal(writes,1);
 current=structuredClone(expected);
 const bad=await restoreResources(expected,original,'s',hash,{read:io.read,edit:async step=>{await io.edit(step);current.steps[0].stepDetailDTO.scriptStepResourceList[0].scriptStepResourceId='replaced';return true;}});
 assert.equal(bad.success,false);assert.equal(bad.reason,'post-write-mismatch');
});
test('explicit ID-refresh opt-in is narrow, rolling, and retains ID evidence',async()=>{
 const base=fixture();base.steps[0].stepDetailDTO.scriptStepResourceList=[{scriptStepResourceId:'old',fileId:'keep',description:'same'}];base.steps.push({...structuredClone(base.steps[0]),stepId:'b'});
 const desired=structuredClone(base);desired.steps.forEach(s=>s.stepDetailDTO.llmPrompt='new');
 const run=async(opt,mutate=()=>{})=>{let current=structuredClone(base),writes=0;const result=await applyIncremental(base,desired,{read:async()=>structuredClone(current),edit:async step=>{writes++;step.stepDetailDTO.scriptStepResourceList[0].scriptStepResourceId=`new-${step.stepId}`;mutate(step);current.steps=current.steps.map(s=>s.stepId===step.stepId?step:s);return true;}},true,opt);return {result,writes};};
 const good=await run({allowResourceBindingIdRefresh:true});assert.equal(good.result.success,true);assert.equal(good.writes,2);assert.equal(good.result.resourceBindingIdMappings.length,2);assert.deepEqual(good.result.resourceBindingIdMappings[0],{stepId:'s',index:0,oldId:'old',newId:'new-s'});
 assert.equal((await run({})).result.reason,'post-write-mismatch');
 for(const mutate of [s=>s.stepDetailDTO.scriptStepResourceList[0].description='changed',s=>s.stepDetailDTO.scriptStepResourceList[0].scriptStepResourceId='',s=>s.stepDetailDTO.scriptStepResourceList.push({...s.stepDetailDTO.scriptStepResourceList[0]})]){const bad=await run({allowResourceBindingIdRefresh:true},mutate);assert.equal(bad.result.success,false);assert.equal(bad.writes,1);}
 let current=structuredClone(base),reads=0,writes=0;
 const concurrent=await applyIncremental(base,desired,{read:async()=>{reads++;if(reads===4)current.steps[0].stepDetailDTO.scriptStepResourceList[0].scriptStepResourceId='outside-change';return structuredClone(current);},edit:async step=>{writes++;step.stepDetailDTO.scriptStepResourceList[0].scriptStepResourceId='new-id';current.steps[0]=step;return true;}},true,{allowResourceBindingIdRefresh:true});
 assert.equal(concurrent.reason,'concurrent-change');assert.equal(writes,1);assert.equal(concurrent.resourceBindingIdMappings.length,1);
});
test('control token normalization only changes six existing flow token pairs',async()=>{
 const base=fixture();base.trainTaskId='LpIITNFm95atHPjt';base.steps=Array.from({length:6},(_,i)=>({...structuredClone(base.steps[0]),stepId:`s${i}`}));base.steps.push({...structuredClone(base.steps[0]),stepId:'end',stepDetailDTO:{nodeType:'SCRIPT_END'}});
 base.flows=Array.from({length:6},(_,i)=>{const text='`'+(i===5?'本次实训到此结束':'接下来我们将进入下一阶段')+'`';return {trainTaskId:base.trainTaskId,flowId:`f${i}`,scriptStepStartId:`s${i}`,scriptStepEndId:i===5?'end':`s${i+1}`,flowCondition:text,flowConfiguration:{relation:'and',conditions:[{text:'组',conditions:[{text}]}]},custom:'keep'};});
 let current=structuredClone(base),writes=0;
 const result=await normalizeControlTokens(base,fullSnapshotFingerprint(base),{read:async()=>structuredClone(current),editFlow:async flow=>{writes++;current.flows=current.flows.map(f=>f.flowId===flow.flowId?flow:f);return true;}});
 assert.equal(result.success,true);assert.equal(writes,6);assert.deepEqual(current.steps,base.steps);
 const expected=structuredClone(base);for(const c of planControlTokenNormalization(base))expected.flows[c.index]=c.flow;assert.deepEqual(current,expected);
 const wrong=structuredClone(base);wrong.trainTaskId='other';assert.throws(()=>planControlTokenNormalization(wrong),/精密度/);
 const leaf=structuredClone(base);leaf.flows[0].flowConfiguration.conditions[0].conditions[0].text='other';assert.throws(()=>planControlTokenNormalization(leaf),/不一致/);
 current=structuredClone(base);current.steps[0].stepDetailDTO.agentId='outside';writes=0;
 const conflict=await normalizeControlTokens(base,fullSnapshotFingerprint(base),{read:async()=>structuredClone(current),editFlow:async()=>{writes++;return true;}});assert.equal(conflict.reason,'concurrent-change');assert.equal(writes,0);
 current=structuredClone(base);
 const bad=await normalizeControlTokens(base,fullSnapshotFingerprint(base),{read:async()=>structuredClone(current),editFlow:async flow=>{writes++;flow.custom='lost';current.flows[0]=flow;return true;}});assert.equal(bad.reason,'post-write-mismatch');assert.equal(writes,1);
});
const backgroundDesired = (type='ability') => {
 const base=fixture();base.type=type;
 Object.assign(base.steps[0].stepDetailDTO,{scriptStepCover:{fileId:'old',fileUrl:'https://example.org/old',fileName:null,custom:{keep:true}},backgroundTheme:'old',endStrategy:2,interactiveRounds:3,trainTime:-1});
 Object.assign(base.steps[0].stepDetailDTO.stepExtProperty,type==='oral'?{backgroundTheme:'old'}:{bgMediaType:1});
 const desired=structuredClone(base),d=desired.steps[0].stepDetailDTO;
 Object.assign(d.scriptStepCover,{fileId:'new',fileUrl:'https://example.org/new',fileName:null});d.backgroundTheme='new';
 if(type==='oral')d.stepExtProperty.backgroundTheme='new';
 return {base,desired};
};
test('complete background and ending patches preserve all other fields for both types',async()=>{
 for(const type of ['ability','oral']) {
  const {base,desired}=backgroundDesired(type),saved=structuredClone(base);
  Object.assign(desired.steps[0].stepDetailDTO,{endStrategy:0,interactiveRounds:-1,trainTime:-1});
  const plan=planIncremental(base,desired);assert.equal(plan.changes.length,1);assert.ok(plan.changes[0].fields.includes('scriptStepCover'));
  let current=structuredClone(base),writes=0;
  const result=await applyIncremental(base,desired,{read:async()=>structuredClone(current),edit:async step=>{writes++;current.steps[0]=step;return true;}},true);
  assert.equal(result.success,true);assert.equal(writes,1);assert.deepEqual(base,saved);
  assert.deepEqual(current.steps[0].stepDetailDTO.scriptStepResourceList,base.steps[0].stepDetailDTO.scriptStepResourceList);
 }
});
test('incomplete unsafe backgrounds and changes outside exact paths reject before IO',async()=>{
 const mutations=[
  d=>delete d.scriptStepCover.fileId,d=>delete d.scriptStepCover.fileUrl,
  d=>d.scriptStepCover.fileUrl='http://example.org/a',d=>d.scriptStepCover.fileUrl='https://u:p@example.org/a',
  d=>d.scriptStepCover.fileUrl='javascript:alert(1)',d=>d.scriptStepCover.fileId=' ',
  d=>d.backgroundTheme='wrong',d=>d.scriptBackgroundType='video',
  d=>delete d.stepExtProperty.bgMediaType,d=>d.stepExtProperty.bgMediaType=2,
  d=>d.scriptStepCover.custom.keep=false,d=>d.stepExtProperty.other='new',
  d=>d.scriptStepResourceList=[],d=>d.stepName='renamed',d=>d.stepExtProperty=[]
 ];
 for(const mutate of mutations){const {base,desired}=backgroundDesired();mutate(desired.steps[0].stepDetailDTO);let reads=0;
  await assert.rejects(applyIncremental(base,desired,{read:async()=>{reads++;return base;},edit:async()=>true},true));assert.equal(reads,0);
 }
 const {base,desired}=backgroundDesired('oral');delete desired.steps[0].stepDetailDTO.stepExtProperty.backgroundTheme;assert.throws(()=>planIncremental(base,desired));
});
test('ending group strictly validates numbers modes bounds and completeness',()=>{
 const {base}=backgroundDesired();
 for(const tuple of [[2,0,-1],[2,30,-1],[0,-1,-1],[0,-1,1],[0,-1,480]]){
  const desired=structuredClone(base);Object.assign(desired.steps[0].stepDetailDTO,{endStrategy:tuple[0],interactiveRounds:tuple[1],trainTime:tuple[2]});assert.doesNotThrow(()=>planIncremental(base,desired));
 }
 for(const tuple of [[2,-1,-1],[2,31,-1],[2,1.5,-1],[2,'3',-1],[2,NaN,-1],[2,Infinity,-1],[2,3,0],[0,0,-1],[0,-1,0],[0,-1,481],[0,-1,1.5],[1,3,-1],[2,4,undefined]]){
  const desired=structuredClone(base);Object.assign(desired.steps[0].stepDetailDTO,{endStrategy:tuple[0],interactiveRounds:tuple[1],trainTime:tuple[2]});assert.throws(()=>planIncremental(base,desired));
 }
});
test('background and strategy cannot change boundary nodes or outer topology',()=>{
 const {base,desired}=backgroundDesired();base.steps[0].stepDetailDTO.nodeType='SCRIPT_START';desired.steps[0].stepDetailDTO.nodeType='SCRIPT_START';
 const node={...structuredClone(base.steps[0]),stepId:'content',stepDetailDTO:{...base.steps[0].stepDetailDTO,nodeType:'SCRIPT_NODE'}};base.steps.push(node);desired.steps.push(structuredClone(node));assert.throws(()=>planIncremental(base,desired));
 const pair=backgroundDesired();pair.desired.steps[0].positionDTO.x=3;assert.throws(()=>planIncremental(pair.base,pair.desired));
});
test('placeholder materialization remains a mismatch even with binding ID refresh opt-in',async()=>{
 const {base,desired}=backgroundDesired();
 const placeholder={scriptStepResourceId:null,fileId:null,type:null,isRequired:null,trainTaskId:null,scriptStepId:null,resourceTypeNid:'default',category:'未分类'};
 base.steps[0].stepDetailDTO.scriptStepResourceList=[structuredClone(placeholder)];desired.steps[0].stepDetailDTO.scriptStepResourceList=[structuredClone(placeholder)];
 base.steps.push({...structuredClone(base.steps[0]),stepId:'b'});desired.steps.push({...structuredClone(desired.steps[0]),stepId:'b'});
 let current=structuredClone(base),writes=0;
 const result=await applyIncremental(base,desired,{read:async()=>structuredClone(current),edit:async step=>{
  writes++;Object.assign(step.stepDetailDTO.scriptStepResourceList[0],{scriptStepResourceId:'materialized',type:'resource',isRequired:0,trainTaskId:'t',scriptStepId:step.stepId});current.steps[0]=step;return true;
 }},true,{allowResourceBindingIdRefresh:true});
 assert.equal(result.success,false);assert.equal(result.reason,'post-write-mismatch');assert.equal(result.reconciliationRequired,true);assert.equal(writes,1);assert.deepEqual(result.applied,['s']);
});
test('partial failure returns evidence and never retries or fresh falls back',async()=>{
 const base=fixture();base.steps.push({...structuredClone(base.steps[0]),stepId:'b',stepDetailDTO:{...structuredClone(base.steps[0].stepDetailDTO),stepName:'B'}});
 const desired=structuredClone(base);desired.steps.forEach(s=>s.stepDetailDTO.llmPrompt='new');let current=structuredClone(base),writes=0;
 const result=await applyIncremental(base,desired,{read:async()=>structuredClone(current),edit:async step=>{writes++;if(writes===2)throw Error('lost response');current.steps[0]=step;return true;}},true);
 assert.equal(result.success,false);assert.deepEqual(result.applied,['s']);assert.equal(result.failedStepId,'b');assert.equal(writes,2);assert.equal(result.reconciliationRequired,true);
});
