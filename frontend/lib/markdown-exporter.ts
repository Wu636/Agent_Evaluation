import { EvaluationReport, DimensionScore } from './llm/types';
import { DIMENSIONS } from './config';

/**
 * 获取评分等级
 */
const getScoreLabel = (score: number, fullScore: number = 100): string => {
    const ratio = score / fullScore;
    if (ratio >= 0.9) return '优秀';
    if (ratio >= 0.75) return '良好';
    if (ratio >= 0.6) return '合格';
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
    markdown += `- **总分**: ${report.total_score.toFixed(1)} / 100\n`;
    markdown += `- **评级**: ${report.final_level}\n`;

    if (report.veto_reasons && report.veto_reasons.length > 0) {
        markdown += `- **一票否决**: ${report.veto_reasons.join('; ')}\n`;
    }

    markdown += `\n`;

    // 各维度评分概览
    markdown += `## 📈 维度评分概览\n\n`;
    markdown += `| 维度 | 分数 | 评级 | 权重 |\n`;
    markdown += `|------|------|------|------|\n`;

    // 兼容数组或对象格式
    const dimensionsList = Array.isArray(report.dimensions)
        ? report.dimensions
        : Object.entries(report.dimensions as any).map(([key, value]: any) => ({
            dimension: DIMENSIONS[key]?.name || key,
            score: value.score,
            level: getScoreLabel(value.score, 20),
            weight: 0.2,
            full_score: 20,
            analysis: value.comment,
            sub_scores: [],
            isVeto: false,
            weighted_score: value.score
        }));

    dimensionsList.forEach((dim: any) => {
        markdown += `| ${dim.dimension} | ${dim.score.toFixed(1)} | ${dim.level || getScoreLabel(dim.score, 20)} | ${(dim.weight * 100).toFixed(0)}% |\n`;
    });

    // 各维度详细分析
    markdown += `\n---\n\n`;
    markdown += `## 📝 维度详细评测\n\n`;

    dimensionsList.forEach((dim: DimensionScore) => {
        markdown += `### ${dim.dimension} (${dim.score.toFixed(1)}分)\n\n`;

        // 子维度详情
        if (dim.sub_scores && dim.sub_scores.length > 0) {
            markdown += `#### 子维度评分\n\n`;

            dim.sub_scores.forEach(sub => {
                const icon = ["优秀", "良好", "合格"].includes(sub.rating) ? "✅" : "⚠️";
                markdown += `**${icon} ${sub.sub_dimension}**\n\n`;
                markdown += `- **分数**: ${sub.score} / ${sub.full_score} (${sub.rating})\n`;
                markdown += `- **判定依据**: ${sub.judgment_basis}\n`;

                // 问题列表
                if (sub.issues && sub.issues.length > 0) {
                    markdown += `- **发现问题**:\n`;
                    sub.issues.forEach(issue => {
                        markdown += `  - **${issue.description}** (${issue.severity === 'high' ? '严重' : '一般'})\n`;
                        markdown += `    > 位置: ${issue.location}\n`;
                        markdown += `    > 引用: "${issue.quote}"\n`;
                    });
                }

                // 亮点列表
                if (sub.highlights && sub.highlights.length > 0) {
                    markdown += `- **亮点表现**:\n`;
                    sub.highlights.forEach(highlight => {
                        markdown += `  - **${highlight.description}**\n`;
                        markdown += `    > 引用: "${highlight.quote}"\n`;
                    });
                }

                markdown += `\n`;
            });
        }

        // 总体分析（兼容旧格式或汇总分析）
        if (dim.analysis && (!dim.sub_scores || dim.sub_scores.length === 0)) {
            markdown += `#### 维度分析\n\n${dim.analysis}\n\n`;
        }

        markdown += `---\n\n`;
    });

    // 整体分析
    if (report.analysis) {
        markdown += `## 🔍 整体综合分析\n\n`;
        markdown += `${report.analysis}\n\n`;
        markdown += `---\n\n`;
    }

    // 关键问题汇总
    if (report.issues && report.issues.length > 0) {
        markdown += `## ⚠️ 关键问题汇总\n\n`;
        report.issues.forEach((issue, index) => {
            markdown += `${index + 1}. ${issue}\n`;
        });
        markdown += `\n`;
    }

    // 优化建议汇总
    if (report.suggestions && report.suggestions.length > 0) {
        markdown += `## 💡 优化建议汇总\n\n`;
        report.suggestions.forEach((suggestion, index) => {
            markdown += `${index + 1}. ${suggestion}\n`;
        });
        markdown += `\n`;
    }

    markdown += `---\n\n`;
    markdown += `*本报告由智能体评测系统自动生成*\n`;

    return markdown;
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
