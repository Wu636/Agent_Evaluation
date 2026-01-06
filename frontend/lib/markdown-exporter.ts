import { EvaluationReport } from './api';

/**
 * 获取维度中文名称
 */
const DIMENSION_NAMES: Record<string, string> = {
    teaching_goal_completion: '目标达成度',
    teaching_strategy: '策略引导力',
    workflow_consistency: '流程遵循度',
    interaction_experience: '交互体验感',
    hallucination_control: '幻觉控制力',
    robustness: '异常处理力',
};

const getDimensionName = (key: string): string => {
    return DIMENSION_NAMES[key] || key;
};

/**
 * 获取评分等级
 */
const getScoreLabel = (score: number): string => {
    if (score >= 90) return '优秀';
    if (score >= 75) return '良好';
    if (score >= 60) return '合格';
    return '需改进';
};

/**
 * 将评测报告转换为 Markdown 格式
 */
export function formatReportToMarkdown(report: EvaluationReport): string {
    const timestamp = new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });

    let markdown = '';

    // 标题和总分
    markdown += `# 智能体评测报告\n\n`;
    markdown += `**生成时间**: ${timestamp}\n\n`;
    markdown += `---\n\n`;
    markdown += `## 📊 总体评分\n\n`;
    markdown += `**总分**: ${report.total_score.toFixed(1)} / 100\n\n`;
    markdown += `**评级**: ${getScoreLabel(report.total_score)}\n\n`;

    // 各维度评分表格
    markdown += `---\n\n`;
    markdown += `## 📈 维度评分详情\n\n`;
    markdown += `| 维度 | 分数 | 评级 |\n`;
    markdown += `|------|------|------|\n`;

    Object.entries(report.dimensions).forEach(([key, data]) => {
        const dimName = getDimensionName(key);
        const score = data.score;
        const level = getScoreLabel(score);
        markdown += `| ${dimName} | ${score} | ${level} |\n`;
    });

    // 各维度详细分析
    markdown += `\n---\n\n`;
    markdown += `## 📝 维度详细分析\n\n`;

    Object.entries(report.dimensions).forEach(([key, data]) => {
        const dimName = getDimensionName(key);
        markdown += `### ${dimName}\n\n`;
        markdown += `**分数**: ${data.score} / 100\n\n`;
        markdown += `**分析**:\n\n`;
        markdown += `${data.comment}\n\n`;
    });

    // 整体分析
    if (report.analysis) {
        markdown += `---\n\n`;
        markdown += `## 🔍 整体分析\n\n`;
        markdown += `${report.analysis}\n\n`;
    }

    // 关键问题
    if (report.issues && report.issues.length > 0) {
        markdown += `---\n\n`;
        markdown += `## ⚠️ 关键问题\n\n`;

        // 按维度分组
        const groupedIssues = groupItemsByDimension(report.issues);

        Object.entries(groupedIssues).forEach(([dimName, items]) => {
            if (dimName !== '通用') {
                markdown += `### ${getDimensionName(dimName)}\n\n`;
            }
            items.forEach((issue, index) => {
                markdown += `${index + 1}. ${issue}\n`;
            });
            markdown += `\n`;
        });
    }

    // 优化建议
    if (report.suggestions && report.suggestions.length > 0) {
        markdown += `---\n\n`;
        markdown += `## 💡 优化建议\n\n`;

        // 按维度分组
        const groupedSuggestions = groupItemsByDimension(report.suggestions);

        Object.entries(groupedSuggestions).forEach(([dimName, items]) => {
            if (dimName !== '通用') {
                markdown += `### ${getDimensionName(dimName)}\n\n`;
            }
            items.forEach((suggestion, index) => {
                markdown += `${index + 1}. ${suggestion}\n`;
            });
            markdown += `\n`;
        });
    }

    // Prompt 优化建议
    const dims = Object.values(report.dimensions || {});
    const hasStageSuggestions = dims.some((d: any) =>
        d.stage_suggestions && d.stage_suggestions.length > 0
    );

    if (hasStageSuggestions) {
        markdown += `---\n\n`;
        markdown += `## ✨ Prompt 优化建议\n\n`;

        dims.forEach((dimension: any) => {
            dimension.stage_suggestions?.forEach((stageSugg: any) => {
                markdown += `### ${stageSugg.stage_name}\n\n`;

                if (stageSugg.issues && stageSugg.issues.length > 0) {
                    markdown += `**发现问题**:\n\n`;
                    stageSugg.issues.forEach((issue: string) => {
                        markdown += `- ${issue}\n`;
                    });
                    markdown += `\n`;
                }

                if (stageSugg.prompt_fixes && stageSugg.prompt_fixes.length > 0) {
                    markdown += `**Prompt 修改建议**:\n\n`;
                    stageSugg.prompt_fixes.forEach((fix: any) => {
                        markdown += `#### ${fix.section}\n\n`;
                        markdown += `**问题**: ${fix.current_problem}\n\n`;
                        markdown += `**建议**: ${fix.suggested_change}\n\n`;
                    });
                }
            });
        });
    }

    markdown += `---\n\n`;
    markdown += `*本报告由智能体评测系统自动生成*\n`;

    return markdown;
}

/**
 * 分组解析函数：将 "【维度】内容" 格式的字符串数组，
 * 解析为 { "维度": ["内容1", "内容2"], "其他": [...] }
 */
function groupItemsByDimension(items: string[]): Record<string, string[]> {
    const groups: Record<string, string[]> = {};
    const defaultKey = '通用';

    items.forEach(item => {
        const match = item.match(/^【(.*?)】(.*)/);
        if (match) {
            const dimName = match[1].trim();
            const content = match[2].trim();
            if (!groups[dimName]) {
                groups[dimName] = [];
            }
            if (content) {
                groups[dimName].push(content);
            }
        } else {
            if (!groups[defaultKey]) {
                groups[defaultKey] = [];
            }
            groups[defaultKey].push(item);
        }
    });

    return groups;
}

/**
 * 触发浏览器下载 Markdown 文件
 */
export function downloadMarkdown(content: string, filename: string): void {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * 导出评测报告为 Markdown 文件
 */
export function exportReportAsMarkdown(report: EvaluationReport): void {
    const markdown = formatReportToMarkdown(report);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `evaluation-report-${timestamp}.md`;
    downloadMarkdown(markdown, filename);
}
