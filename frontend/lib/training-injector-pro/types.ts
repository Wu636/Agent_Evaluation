import type { ProTrainingConfig } from "../training-generator-pro/types";

/**
 * 能力训练 Pro Markdown 解析后的结构。
 *
 * 单独导出这个别名，是为了让 parser 与注入 route 解耦：
 * parser 只负责把 Markdown 变成 ProTrainingConfig，平台字段转换放在 route 里做。
 */
export type ParsedProConfig = ProTrainingConfig;
