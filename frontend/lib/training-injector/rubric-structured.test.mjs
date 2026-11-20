import test from 'node:test';
import assert from 'node:assert/strict';
import { createRubricSidecar, resolveRubricFastPath, compareScoreItemsExact, parseRubricDeterministic } from './rubric-structured.mjs';
const item = {itemName:'理论应用',score:40,description:'解释理论，保留全部概念。',requireDetail:'- 30—40分：完整解释。\n- 0—29分：存在缺漏。\n特殊规则：事实错误最多扣5分。'};
const md = '# 评价标准\n\n## 总分：40 分\n\n## 理论应用（40 分）\n**评价描述：** '+item.description+'\n\n**评分区间：**\n'+item.requireDetail+'\n';
test('deterministic explicit Markdown preserves every scoring rule and score',()=>{
  assert.deepEqual(parseRubricDeterministic(md),{ok:true,items:[item]});
  assert.equal(resolveRubricFastPath(md).source,'deterministic-markdown');
});
test('raw sidecar keeps exact strings and bypasses lossy Markdown roundtrip',()=>{
  const raw=[{...item,description:'  '+item.description+'\n',itemId:'i1',trainTaskId:'task'}];
  const sidecar=createRubricSidecar(md,raw,'task');
  assert.deepEqual(sidecar.rawScoreItems,raw);
  const result=resolveRubricFastPath(md,sidecar);
  assert.equal(result.source,'platform-sidecar');
  assert.equal(result.items[0].description,raw[0].description);
  assert.equal(result.items[0].requireDetail,raw[0].requireDetail);
});
test('changed rubric hash never reuses stale score data',()=>{
  const sidecar=createRubricSidecar(md,[item],'task');
  const changed=md.replaceAll('40','50');
  const result=resolveRubricFastPath(changed,sidecar);
  assert.equal(result.source,'deterministic-markdown');
  assert.equal(result.items[0].score,50);
});
test('unknown platform fields, aliases and missing rule text block raw shortcut',()=>{
  for(const raw of [[{...item,customDeduction:'new rule'}],[{name:'x',itemScore:40,description:'d',requireDetail:'r'}],[{...item,requireDetail:''}],[{...item,score:'40'}]]){
    const result=resolveRubricFastPath(md,createRubricSidecar(md,raw,'task'));
    assert.equal(result.ok,false); assert.equal(result.blocked,true);
  }
});
test('ambiguous Markdown refuses fast path instead of dropping global rules',()=>{
  for(const text of ['额外总则：迟交扣10分\n'+md,md.replace('## 总分：40','## 总分：100'),md+'\n## 特别扣分\n迟交扣10分',md.replace('**评价描述：**',''),md+'\n```json\n{}\n```']) assert.equal(parseRubricDeterministic(text).ok,false,text);
});
test('exact comparison checks name, score, description and detailed rules, not count',()=>{
  assert.equal(compareScoreItemsExact([item],[{...item,itemId:'abc'}]).ok,true);
  for(const change of [{itemName:'different'},{score:39},{description:'lost'},{requireDetail:'lost'}]) assert.equal(compareScoreItemsExact([item],[{...item,...change}]).ok,false);
  assert.equal(compareScoreItemsExact([item],[item,item]).ok,false);
});
