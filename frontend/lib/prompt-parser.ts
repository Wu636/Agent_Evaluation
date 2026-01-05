/**
 * Prompt 配置解析器
 * 解析 Markdown 格式的工作流 Prompt 配置
 */

export interface StagePrompt {
    stage_name: string; // 环节名称，如 "环节5：标签标识与出圃验收"
    role?: string; // Role 章节内容
    profile?: string; // Profile 章节内容
    rules?: string[]; // Rules 列表
    workflow?: string[]; // Workflow 步骤列表
    output_requirements?: string; // Output Requirements 内容
    full_content: string; // 完整原始内容
}

/**
 * 解析 Markdown 格式的 Prompt 配置
 */
export function parsePromptConfig(content: string): StagePrompt[] {
    const stages: StagePrompt[] = [];

    // 按 ## 环节标题分割
    const stageMatches = content.split(/(?=##\s*环节)/);

    for (const stageContent of stageMatches) {
        if (!stageContent.trim()) continue;

        // 提取环节名称
        const stageNameMatch = stageContent.match(/##\s*(环节\d+[：:].+)/);
        if (!stageNameMatch) continue;

        const stage_name = stageNameMatch[1].trim();

        // 提取各个章节
        const stage: StagePrompt = {
            stage_name,
            full_content: stageContent,
        };

        // 提取 Role (使用 [\s\S] 代替 s 标志以兼容 ES2017)
        const roleMatch = stageContent.match(/##?\s*Role[：:]([\s\S]+?)(?=##|$)/);
        if (roleMatch) {
            stage.role = roleMatch[1].trim();
        }

        // 提取 Profile
        const profileMatch = stageContent.match(
            /##?\s*Profile[（(]人设画像[）)]([\s\S]+?)(?=##|$)/
        );
        if (profileMatch) {
            stage.profile = profileMatch[1].trim();
        }

        // 提取 Rules
        const rulesMatch = stageContent.match(
            /##?\s*Rules[（(]规则与边界约束[）)]([\s\S]+?)(?=##|$)/
        );
        if (rulesMatch) {
            const rulesText = rulesMatch[1].trim();
            // 提取列表项
            const ruleItems = rulesText.match(/^\s*\d+\.\s*(.+)$/gm);
            if (ruleItems) {
                stage.rules = ruleItems.map((item) =>
                    item.replace(/^\s*\d+\.\s*/, "").trim()
                );
            }
        }

        // 提取 Workflow
        const workflowMatch = stageContent.match(
            /##?\s*Workflow[（(]对话流程[）)]([\s\S]+?)(?=##|$)/
        );
        if (workflowMatch) {
            const workflowText = workflowMatch[1].trim();
            // 提取列表项
            const workflowItems = workflowText.match(/^\s*\d+\.\s*\*\*(.+?)\*\*/gm);
            if (workflowItems) {
                stage.workflow = workflowItems.map((item) => {
                    const match = item.match(/\*\*(.+?)\*\*/);
                    return match ? match[1].trim() : item;
                });
            }
        }

        // 提取 Output Requirements
        const outputMatch = stageContent.match(
            /##?\s*Output Requirements[（(]输出要求[）)]([\s\S]+?)$/
        );
        if (outputMatch) {
            stage.output_requirements = outputMatch[1].trim();
        }

        stages.push(stage);
    }

    return stages;
}

/**
 * 根据环节名称查找对应的 Prompt 配置
 */
export function findStagePrompt(
    stages: StagePrompt[],
    stageName: string
): StagePrompt | null {
    // 精确匹配
    let found = stages.find((s) => s.stage_name === stageName);
    if (found) return found;

    // 模糊匹配（去掉"环节X："前缀）
    const normalizedName = stageName.replace(/^环节\d+[：:]\s*/, "");
    found = stages.find((s) => s.stage_name.includes(normalizedName));
    if (found) return found;

    // 反向模糊匹配
    found = stages.find((s) =>
        normalizedName.includes(s.stage_name.replace(/^环节\d+[：:]\s*/, ""))
    );

    return found || null;
}

/**
 * 格式化 Prompt 配置用于 LLM 评估
 */
export function formatPromptForEvaluation(stage: StagePrompt): string {
    const parts = [];

    parts.push(`## ${stage.stage_name}`);

    if (stage.role) {
        parts.push(`\n**角色定位**：${stage.role}`);
    }

    if (stage.profile) {
        parts.push(`\n**人设画像**：\n${stage.profile}`);
    }

    if (stage.rules && stage.rules.length > 0) {
        parts.push(`\n**规则约束**：`);
        stage.rules.forEach((rule, i) => {
            parts.push(`${i + 1}. ${rule}`);
        });
    }

    if (stage.workflow && stage.workflow.length > 0) {
        parts.push(`\n**对话流程**：`);
        stage.workflow.forEach((step, i) => {
            parts.push(`${i + 1}. ${step}`);
        });
    }

    if (stage.output_requirements) {
        parts.push(`\n**输出要求**：\n${stage.output_requirements}`);
    }

    return parts.join("\n");
}
