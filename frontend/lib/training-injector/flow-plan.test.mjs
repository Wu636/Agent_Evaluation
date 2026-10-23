import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrainingScript, parseTrainingScriptFlowConfig, serializeTrainingScriptMarkdown } from './parser.ts';
import { resolveScriptFlowPlan } from './flow-plan.ts';

function fixture() {
  const edges = [{ from: 'START', to: '阶段1', condition: 'BEGIN', isDefault: 1 }];
  for (const first of [2, 6, 10, 14]) {
    edges.push({ from: '阶段1', to: `阶段${first}`, condition: `CHOOSE_${first}`, isDefault: first === 2 ? 1 : 0 });
    for (let number = first; number < first + 3; number++) {
      edges.push({ from: `阶段${number}`, to: `阶段${number + 1}`, condition: `NEXT_${number}`, isDefault: 1 });
    }
    edges.push({ from: `阶段${first + 3}`, to: 'END', condition: `END_${first + 3}`, isDefault: 1 });
  }
  const stages = Array.from({ length: 17 }, (_, index) => [
    `<!-- STAGE_START:${index + 1} -->`,
    `### 阶段${index + 1}: ${index === 0 ? '选择角色' : `角色线路${index + 1}`}`,
    '**阶段描述**: 根据教师文档完成本阶段。',
    '**互动轮次**: 4',
    '**提示词**:', '```markdown', '遵守当前角色线路。', '```',
    `<!-- STAGE_END:${index + 1} -->`,
  ].join('\n')).join('\n\n');
  const markdown = `# 角色分支训练 - 训练剧本配置\n\n## 📝 训练阶段\n\n${stages}\n\n## 🔀 非线性跳转关系\n\n\`\`\`json\n${JSON.stringify({ flowType: 'graph', edges }, null, 2)}\n\`\`\``;
  return { markdown, edges };
}

test('17 阶段四角色分支从剧本解析到注入图均保留，重写阶段后仍保留图', () => {
  const { markdown } = fixture();
  const steps = parseTrainingScript(markdown);
  const flow = parseTrainingScriptFlowConfig(markdown);
  const resolved = resolveScriptFlowPlan(flow, steps);
  assert.equal(steps.length, 17);
  assert.equal(flow.flowType, 'graph');
  assert.equal(resolved.length, 21);
  assert.deepEqual(resolved.filter(({ from }) => from === 0).map(({ to }) => to), [1, 5, 9, 13]);
  assert.deepEqual(resolved.filter(({ to }) => to === 'END').map(({ from }) => from), [4, 8, 12, 16]);
  assert.equal(resolved.some(({ from, to }) => from === 4 && to === 5), false);

  const edited = serializeTrainingScriptMarkdown({ steps, sourceMarkdown: markdown });
  assert.equal(resolveScriptFlowPlan(parseTrainingScriptFlowConfig(edited), parseTrainingScript(edited)).length, 21);
});

test('图配置损坏时保留非线性意图并阻止线性兜底', () => {
  const { markdown } = fixture();
  const broken = markdown.replace(/```json\n[\s\S]*?\n```$/, '```json\n{ "flowType": "graph", "edges": [broken\n```');
  const flow = parseTrainingScriptFlowConfig(broken);
  assert.equal(flow.flowType, 'graph');
  assert.equal(flow.edges.length, 0);
  assert.throws(() => resolveScriptFlowPlan(flow, parseTrainingScript(broken)), /没有解析到任何跳转连线/);
});

test('阶段提示词代码块缺少结束栅栏时仍能识别后面的图结构', () => {
  const { markdown } = fixture();
  const damaged = markdown.replace(
    '遵守当前角色线路。\n```\n<!-- STAGE_END:17 -->',
    '遵守当前角色线路。\n<!-- STAGE_END:17 -->',
  );
  const flow = parseTrainingScriptFlowConfig(damaged);
  assert.equal(flow.flowType, 'graph');
  assert.equal(flow.edges.length, 21);
});

test('任一分支指向不存在的阶段，注入前报出具体边', () => {
  const { markdown } = fixture();
  const steps = parseTrainingScript(markdown);
  const flow = parseTrainingScriptFlowConfig(markdown);
  flow.edges[2].to = '阶段99';
  assert.throws(() => resolveScriptFlowPlan(flow, steps), /阶段2 → 阶段99/);
});

test('显式默认分支即使排在后面也保持唯一，重复默认分支提前报错', () => {
  const { markdown } = fixture();
  const steps = parseTrainingScript(markdown);
  const flow = parseTrainingScriptFlowConfig(markdown);
  const branches = flow.edges.filter((edge) => edge.from === '阶段1');
  branches[0].isDefault = undefined;
  branches[1].isDefault = 1;
  const resolved = resolveScriptFlowPlan(flow, steps).filter(({ from }) => from === 0);
  assert.deepEqual(resolved.map(({ edge }) => edge.isDefault), [0, 1, 0, 0]);
  branches[2].isDefault = 1;
  assert.throws(() => resolveScriptFlowPlan(flow, steps), /多条默认连线/);
});
