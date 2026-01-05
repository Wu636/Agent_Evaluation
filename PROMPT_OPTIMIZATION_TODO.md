## Prompt 优化说明

基于用户反馈，我们需要优化评估 Prompt，让 LLM 给出更具体、可直接使用的 Prompt 修改建议。

## 当前问题

现有的 `suggested_change` 字段返回的建议过于笼统，例如："建议修改为..."，用户无法直接使用。

## 优化方案

### 修改位置
`frontend/lib/llm/prompts.ts` 第 89-113 行

### 修改内容

将现有的工作流配置提示部分替换为：

```typescript
${workflowConfig ? `
## 工作流配置信息

以下是各环节的 Prompt 配置：

${workflowConfig}

## 重要：Prompt 修改建议格式要求

如果发现环节相关问题，请给出**可直接使用**的 Prompt 修改建议。

**要求**：
1. 明确指出问题出现在哪个环节
2. 指出应该修改哪个章节（Role/Profile/Rules/Workflow/Output Requirements）
3. **给出完整的、可以直接复制粘贴到 Prompt 中的规则文本**

**示例**：
- 如果发现重复对话问题 → 建议添加：**禁止重复**：请勿重复使用上一轮对话中完全相同的句子、问候语或问题。
- 如果发现输出乱码 → 建议添加：**输出清晰**：确保输出为清晰的文本。禁止输出乱码和代码。
- 如果回复过长 → 建议修改：每次回复必须控制在200-350字以内。

在 JSON 中添加 stage_suggestions 字段：

\`\`\`json
"stage_suggestions": [
  {
    "stage_name": "环节5：标签标识与出圃验收",
    "issues": ["该环节出现重复对话，降低用户体验"],
    "prompt_fixes": [
      {
        "section": "Rules",
        "current_problem": "缺少对重复内容的限制，导致AI可能重复相同的问题或回复",
        "suggested_change": "**禁止重复**：请勿重复使用上一轮对话中完全相同的句子、问候语或问题。每次回复需要有新的表达方式。"
      }
    ]
  }
]
\`\`\`

**关键**：suggested_change 必须是完整的、格式化好的规则文本，用户可以直接复制到 Prompt 的对应章节中使用。
` : ''}
```

## 实施方式

由于字符转义问题导致 replace 工具失败，建议手动编辑文件或使用更精确的工具。

## 预期效果

修改后，LLM 会返回如下格式的建议：

```json
{
  "section": "Rules",
  "current_problem": "缺少对重复内容的限制",
  "suggested_change": "**禁止重复**：请勿重复使用上一轮对话中完全相同的句子、问候语或问题。每次回复需要有新的表达方式。"
}
```

用户可以直接将 `suggested_change` 的内容复制到对应环节 Prompt 的 Rules 章节中。
