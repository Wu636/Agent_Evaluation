# Gemini/Claude 超时问题说明

## 问题描述

使用 Gemini 或 Claude 模型时，第一个评估维度成功，但之后出现 network error。

## 根本原因

**总评估时间超过 Vercel 函数执行时间限制**：

- 单个维度耗时：40-60 秒
- 6 个评估维度：240-360 秒（4-6 分钟）
- Vercel 免费版限制：**300 秒（5 分钟）**
- 结果：第 3-4 个维度时达到限制，导致 network error

## 解决方案

### 方案 1：使用 GPT 模型（推荐）

GPT-4o 响应速度快（10-20秒/维度），总时间约 60-120 秒，远低于限制。

```
推荐模型：GPT-4o 或 GPT-4o-mini
```

### 方案 2：减少评估维度

临时方案：修改 `frontend/lib/config.ts`，注释掉一些非关键维度：

```typescript
export const DIMENSIONS: Record<string, DimensionConfig> = {
  teaching_goal_completion: { ... },  // 保留
  teaching_strategy: { ... },          // 保留
  // workflow_consistency: { ... },    // 注释掉
  // interaction_experience: { ... },  // 注释掉
  // hallucination_control: { ... },   // 注释掉
  // robustness: { ... },               // 注释掉
};
```

这样只评估 2 个维度，总时间约 80-120 秒。

### 方案 3：升级 Vercel 计划（需要付费）

Vercel Pro 版支持最大 900 秒（15 分钟）执行时间。

修改 `frontend/app/api/evaluate-stream/route.ts`:

```typescript
export const maxDuration = 900; // Pro 版
```

### 方案 4：使用本地运行（无限制）

本地运行没有时间限制：

```bash
npm run dev
```

访问 `http://localhost:3000`

## 技术细节

### 各模型响应时间对比

| 模型 | 单维度耗时 | 6维度总耗时 | 是否超时 |
|------|-----------|------------|---------|
| GPT-4o | 10-20秒 | 60-120秒 | ✅ 正常 |
| GPT-4o-mini | 8-15秒 | 48-90秒 | ✅ 正常 |
| Gemini-2.5-pro | 40-60秒 | 240-360秒 | ⚠️ 边界/超时 |
| Claude Sonnet | 45-70秒 | 270-420秒 | ❌ 超时 |

### Vercel 限制

- **Hobby（免费）**: 10 秒（无流式）或 300 秒（流式）
- **Pro**: 900 秒
- **Enterprise**: 自定义

我们使用的是流式 API，所以免费版有 300 秒限制。

## 推荐

**最佳方案**：使用 GPT-4o 模型

- 速度快
- 响应质量好
- 不会超时
- 免费版完全够用

如果一定要用 Gemini/Claude：

1. 减少到 2-3 个核心维度
2. 或升级到 Vercel Pro
3. 或使用本地运行
