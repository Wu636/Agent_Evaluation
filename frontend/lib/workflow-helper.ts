/**
 * 工作流配置相关辅助函数
 */

import { StagePrompt, parsePromptConfig, formatPromptForEvaluation } from './prompt-parser';

/**
 * 为评估添加工作流配置信息
 */
export function buildWorkflowContext(workflowConfigContent: string): string {
    const stages = parsePromptConfig(workflowConfigContent);

    if (stages.length === 0) {
        return '';
    }

    const lines = [
        '\n\n## 工作流配置信息\n',
        '以下是各环节的 Prompt 配置，请在评估时关联对话中的问题到具体环节：\n'
    ];

    stages.forEach(stage => {
        lines.push(`\n### ${stage.stage_name}\n`);
        lines.push(formatPromptForEvaluation(stage));
    });

    lines.push('\n\n## 如果发现环节相关问题，请在返回的 JSON 中添加：\n');
    lines.push('```json');
    lines.push('"stage_suggestions": [');
    lines.push('  {');
    lines.push('    "stage_name": "环节名称",');
    lines.push('    "issues": ["该环节的具体问题"],');
    lines.push('    "prompt_fixes": [');
    lines.push('      {');
    lines.push('        "section": "Rules/Workflow/Profile等",');
    lines.push('        "current_problem": "当前 Prompt 的问题",');
    lines.push('        "suggested_change": "建议的修改方向"');
    lines.push('      }');
    lines.push('    ]');
    lines.push('  }');
    lines.push(']');
    lines.push('```\n');

    return lines.join('\n');
}
