import test from 'node:test';
import assert from 'node:assert/strict';
import { findIncompleteTrainingScriptStageIndex } from './script-completion.ts';

function fixture(count = 17, lastPrompt = '请完成个体化用药和肝功能监护。') {
    const stages = Array.from({ length: count }, (_, index) => ({
        heading: `### 阶段${index + 1}: 阶段名称`,
        markdown: `<!-- STAGE_START:${index + 1} -->\n### 阶段${index + 1}: 阶段名称\n**提示词**:\n${index === count - 1 ? lastPrompt : '完整提示词。'}\n<!-- STAGE_END:${index + 1} -->`,
    }));
    const steps = Array.from({ length: count }, (_, index) => ({
        stepName: '阶段名称',
        llmPrompt: index === count - 1 ? lastPrompt : '完整提示词。',
        flowCondition: 'NEXT',
    }));
    return { stages, steps };
}

test('阶段17提示词写到“不”时，重生成阶段17，即使阶段结束标记已输出', () => {
    const { stages, steps } = fixture(17, '轻度肝功能异常需评估异常程度、药物肝毒性及合并用药，不');
    assert.equal(findIncompleteTrainingScriptStageIndex(stages, steps, 17, false), 16);
    assert.equal(findIncompleteTrainingScriptStageIndex(stages, steps, 17, true), 16);
});

test('阶段17缺少结束标记时，不将配置说明当作续写目标', () => {
    const { stages, steps } = fixture();
    stages[16].markdown = stages[16].markdown.replace('<!-- STAGE_END:17 -->', '## ⚙️ 配置说明');
    assert.equal(findIncompleteTrainingScriptStageIndex(stages, steps, 17, false), 16);
});

test('前16阶段完整而第17阶段尚未出现时，从阶段17开始', () => {
    const { stages, steps } = fixture(16);
    assert.equal(findIncompleteTrainingScriptStageIndex(stages, steps, 17, false), -1);
});

test('阶段17已结束而仅缺文档结束标志时，可单独补文档尾部', () => {
    const { stages, steps } = fixture();
    assert.equal(findIncompleteTrainingScriptStageIndex(stages, steps, 17, false), -1);
});

test('无阶段边界的旧版输出缺少完整标志时，重生成末阶段', () => {
    const { stages, steps } = fixture();
    for (const stage of stages) stage.markdown = stage.heading;
    assert.equal(findIncompleteTrainingScriptStageIndex(stages, steps, 17, false), 16);
});

test('旧版剧本在阶段5截断、规划还有后续阶段时，先补齐阶段5', () => {
    const { stages, steps } = fixture(5, '继续分析证据。');
    for (const stage of stages) stage.markdown = stage.heading;
    assert.equal(findIncompleteTrainingScriptStageIndex(stages, steps, 8, false), 4);
});

test('完整文档通过阶段完整性检查', () => {
    const { stages, steps } = fixture();
    assert.equal(findIncompleteTrainingScriptStageIndex(stages, steps, 17, true), -1);
});
