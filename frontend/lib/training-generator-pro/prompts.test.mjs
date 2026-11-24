import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRO_SCRIPT_TEMPLATE,
  PRO_SCRIPT_SYSTEM_PROMPT,
  PRO_TEMPLATE_VERSION,
  buildProScriptGeneratorPrompt,
  resolveProPromptTemplateCache,
} from './prompts.ts';

test('Pro 默认模板版本升级并统一五维剧本事件粒度', () => {
  assert.equal(PRO_TEMPLATE_VERSION, 6);
  assert.match(PRO_SCRIPT_TEMPLATE, /统一总纲/);
  assert.match(PRO_SCRIPT_TEMPLATE, /事件\s*\d+\.\d+/);
  assert.match(PRO_SCRIPT_TEMPLATE, /执行角色/);
  assert.match(PRO_SCRIPT_TEMPLATE, /等待用户/);
  assert.match(PRO_SCRIPT_TEMPLATE, /结束标志/);
  assert.match(PRO_SCRIPT_TEMPLATE, /500 字仅是参考，不是强制分拆阈值/);
  assert.doesNotMatch(PRO_SCRIPT_TEMPLATE, /@用户/);
});

test('Pro 成员与评分约束不越界', () => {
  assert.match(PRO_SCRIPT_TEMPLATE, /成员仅可来源于教师文档或当前用户明确要求/);
  assert.match(PRO_SCRIPT_TEMPLATE, /不在本 Pro 输出中新增评价标准/);
  assert.match(PRO_SCRIPT_TEMPLATE, /已有.*评分.*不改写|评分.*不改写/);
  assert.doesNotMatch(PRO_SCRIPT_TEMPLATE, /Pro 版不支持评分/);
  assert.doesNotMatch(PRO_SCRIPT_TEMPLATE, /点餐|双语|中英|服务员.*顾客/);
});

test('Pro 资源技能展示图与自定义技能分开且不伪造资源', () => {
  assert.match(PRO_SCRIPT_TEMPLATE, /resource_skill/);
  assert.match(PRO_SCRIPT_TEMPLATE, /原生.*技能|平台原生技能/);
  assert.match(PRO_SCRIPT_TEMPLATE, /自定义技能/);
  assert.match(PRO_SCRIPT_TEMPLATE, /不伪造.*(?:文件|URL|ID)|不得伪造.*(?:文件|URL|ID)/);
  assert.match(PRO_SCRIPT_TEMPLATE, /待绑定/);
  assert.match(PRO_SCRIPT_TEMPLATE, /不能仅靠提示词上传|不要假设.*上传/);
});

test('只剧本输出禁止复述教师原评分，同时保留平台既有评分', () => {
  const teacherDoc = '教师材料：## 既有评价标准配置\n语音语调评分占比30%，保留原量表全文。';
  const prompt = buildProScriptGeneratorPrompt(teacherDoc);
  assert.ok(prompt.includes(teacherDoc), '教师输入保持原样，由输出约束限定产物而非篡改来源');
  for (const rules of [PRO_SCRIPT_SYSTEM_PROMPT, PRO_SCRIPT_TEMPLATE]) {
    assert.match(rules, /输出完全不含评分章节、评价标准或量表/);
    assert.match(rules, /即使教师文档包含评分.*(?:不抄录|不复述)/);
    assert.match(rules, /不输出评分内容不等于删除或修改平台已有评分/);
  }
  assert.match(PRO_SCRIPT_TEMPLATE, /禁止输出“既有评价标准配置”/);
});

test('每个阶段显式输出剧本模型，不能由成员模型代替', () => {
  assert.match(PRO_SCRIPT_TEMPLATE, /每个阶段.*剧本模型/);
  const stageFormat = PRO_SCRIPT_TEMPLATE.split('## 训练剧本')[1].split('# 最终约束')[0];
  assert.match(stageFormat, /^\*\*剧本模型\*\*: deepseek-v4-flash$/m);
  assert.match(stageFormat, /每个阶段.*剧本模型/);
  assert.match(PRO_SCRIPT_TEMPLATE, /成员.*模型.*不能替代.*剧本模型/);
});

test('教师界面愿望不能直接当作已核实平台能力', () => {
  const prompt = buildProScriptGeneratorPrompt('教师希望提供六语按钮、独立面板和自动动画。');
  assert.ok(/未核实平台功能.*不得.*(?:按钮|面板)/.test(prompt), '必须明确禁止把未核实的界面功能写成已有事实');
  assert.ok(/教师.*(?:愿望|设想).*不等于.*(?:已实现|已支持)/.test(prompt));
  assert.ok(/按钮.*独立面板.*自动动画/.test(prompt));
  assert.ok(/待核实.*(?:文字|文本).*替代/.test(prompt), '需提供不依赖虚构界面的替代流程');
});

test('对话展示教学图片即规划原生资源技能，不以教师点名类型为前提', () => {
  assert.ok(/只要.*对话.*展示.*图片.*必须.*resource_skill/.test(PRO_SCRIPT_TEMPLATE));
  assert.ok(/不以.*(?:明确声明|点名).*resource_skill.*为前提/.test(PRO_SCRIPT_TEMPLATE));
  assert.ok(!/如果教师文档或当前用户明确声明了平台原生|若文档明确声明原生 resource_skill/.test(PRO_SCRIPT_TEMPLATE), '移除旧的显式声明门槛，防止输出格式重新引入矛盾');
  assert.ok(/负责展示的成员.*调用时机.*再次查看/.test(PRO_SCRIPT_TEMPLATE));
  assert.ok(/背景.*普通附件.*不能替代.*资源技能/.test(PRO_SCRIPT_TEMPLATE));
  assert.ok(/纯装饰背景.*不需要/.test(PRO_SCRIPT_TEMPLATE));
  assert.ok(/对话.*展示.*图片.*另起对应技能条目/.test(PRO_SCRIPT_TEMPLATE));
});

test('成员全名后以空格分隔动作，避免校验吞入后续动词', () => {
  const rules = PRO_SCRIPT_TEMPLATE.split('# 成员引用规则')[1].split('# 平台能力')[0];
  assert.ok(/@成员全名.*空格.*动作/.test(rules));
  assert.ok(/正确：@文档中声明的 AI 成员 执行核验/.test(rules));
  assert.ok(!/正确：@文档中声明的 AI 成员执行核验/.test(rules));
  assert.ok(/禁止.*成员全名.*动词.*紧贴/.test(rules));
  assert.ok(/执行角色.*动作.*继续条件.*结束标志/.test(rules), '规则覆盖全部可能引用成员的事件字段');
});

test('模板缓存保留旧版本的用户编辑，不因版本升级自动抹掉', () => {
  const edited = `${PRO_SCRIPT_TEMPLATE}\n用户编辑约束：保留这段内容`;
  const raw = JSON.stringify({ version: 5, template: edited });
  assert.equal(resolveProPromptTemplateCache(raw), edited);
  assert.equal(resolveProPromptTemplateCache(JSON.stringify({ version: 5, template: '无占位符' })), PRO_SCRIPT_TEMPLATE);
  assert.equal(resolveProPromptTemplateCache('not-json'), PRO_SCRIPT_TEMPLATE);
});

test('生成 prompt 仍替换教师文档并保留用户建议', () => {
  const prompt = buildProScriptGeneratorPrompt('任务文档：一次性完成信息采集', undefined, '保留用户的一次性完整回答');
  assert.match(prompt, /任务文档：一次性完成信息采集/);
  assert.match(prompt, /保留用户的一次性完整回答/);
  assert.doesNotMatch(prompt, /\{teacherDoc\}/);
});
