# LLM 网关接入说明（可在其他项目复用）

整理时间：2026-10-29。基于本仓库现有实现，并对 `llm-service.polymas.com` 做了实测连通性验证。

本仓库不直连 OpenAI / Anthropic 官方，而是统一走**智慧树 Polymas LLM 网关**。该网关对外暴露 OpenAI 兼容协议，所以任何支持 "OpenAI 兼容接口" 的 SDK/框架都能直接用，只要换掉 base URL 和 key。

---

## 1. 一句话结论

| 项 | 值 |
| --- | --- |
| 协议 | OpenAI Chat Completions 兼容 |
| Base URL（推荐） | `https://llm-service.polymas.com/api/openai/v1` |
| Chat 地址 | `https://llm-service.polymas.com/api/openai/v1/chat/completions` |
| 流式地址 | 同上，加 `"stream": true`；或直接用 `.../chat/completions/stream` |
| 模型列表 | `https://llm-service.polymas.com/api/openai/v1/models`（实测 292 个） |
| 生图 | `https://llm-service.polymas.com/api/openai/v1/images/generations` |
| 鉴权 | 请求头带 `api-key: <KEY>`（必需）；`Authorization: Bearer <KEY>` 也认 |
| Key 放哪 | 仓库根 `.env` 第 12 行 `LLM_API_KEY`；`frontend/.env.local` 第 5 行 |

> 实测（2026-10-29）：`http://` 和 `https://` 都能通，但**新项目请用 HTTPS**。仓库里旧环境变量写的是 `http://`，代码层面对 polymas 域名会自动升级为 https。

---

## 2. 鉴权

两种 header 都可用，本仓库默认**两个都发**，兼容性最好：

```bash
-H "api-key: $LLM_API_KEY" \
-H "Authorization: Bearer $LLM_API_KEY"
```

实测结果：

| 请求头 | 结果 |
| --- | --- |
| 只发 `api-key` | 200 |
| 只发 `Authorization: Bearer` | 200 |
| 都不发 | 500，`Required header 'api-key' is not present` |

实现位置：[frontend/lib/llm/utils.ts:36](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/llm/utils.ts#L36)

Key 本身是 `sk-` 开头的字符串（51 位）。注意：**根 `.env` 里的 `ARK_API_KEY` 与 `LLM_API_KEY` 是同一个 key**（已比对一致），既能调网关，也能直连火山方舟。

---

## 3. 最小可用调用

### curl

```bash
curl -sS https://llm-service.polymas.com/api/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "api-key: $LLM_API_KEY" \
  -d '{
    "model": "gpt-4o",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

### Node / TypeScript（fetch）

```ts
const res = await fetch("https://llm-service.polymas.com/api/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "api-key": process.env.LLM_API_KEY!,
    Authorization: `Bearer ${process.env.LLM_API_KEY}`,
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    maxTokens: 8000,          // 走该网关的 Claude 用驼峰字段
    messages: [
      { role: "system", content: "只输出 JSON。" },
      { role: "user", content: prompt },
    ],
  }),
});
const data = await res.json();
const text = data.choices[0].message.content;
```

### Python（可直接用官方 openai SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://llm-service.polymas.com/api/openai/v1",
    api_key=os.environ["LLM_API_KEY"],  # 会以 Bearer 发送，网关接受
)
resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

仓库里 Python 侧同样写法见 [homework_review/skill_generation_service.py:18](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/homework_review/skill_generation_service.py#L18) 与 [homework_review/llm_answer_corrector.py:35](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/homework_review/llm_answer_corrector.py#L35)。

---

## 4. 请求体字段注意事项（踩过的坑）

不同厂商模型对这个网关的字段要求不一致，本仓库做了兼容处理，新项目照抄即可：

| 场景 | 字段写法 | 说明 |
| --- | --- | --- |
| OpenAI 常规模型（gpt-4o、gpt-4.1） | `max_tokens` + `temperature` | 标准 OpenAI |
| GPT-5 / o1 / o3 / o4 系列 | `max_completion_tokens`，**去掉 `temperature`** | 上游会对 temperature 报错 |
| 该网关的 Claude | `maxTokens`（驼峰） | 仓库统一用驼峰，实测 `max_tokens` 也返回 200，但混用容易踩额度不一致 |
| 通用兜底 | 同时带 `maxTokens` + `max_tokens` | 本仓库对非 polymas 的兼容端点这样兜底 |
| `reasoning_effort` | 仅推理模型可用，可设 `"low"` 降延迟 | 用于压缩 504 风险 |

实现位置：[frontend/lib/llm/utils.ts:387-412](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/llm/utils.ts#L396)

---

## 5. 流式（SSE）细节

这个网关的流式响应**不完全符合 OpenAI 规范**，新项目需要按下面两点解析：

1. 增量文本在 `choices[0].message.content`，而不是标准的 `choices[0].delta.content`。本仓库两者都读：
   ```ts
   const content = choice?.delta?.content ?? choice?.message?.content;
   ```
2. **流末尾没有 `data: [DONE]`**。实测最后两条是：
   - `{"choices":[{"index":0,"message":{"content":null},"finish_reason":"length"}]}`
   - `{"usage":{...},"choices":[]}`（纯统计帧）
   
   所以不能只等 `[DONE]`，要用 `finish_reason` 或连接关闭作为结束条件。

其它可用的结束信号：`finish_reason === "content_filter"`、`choices[0].message.refusal`，这两类要当作失败处理，不要当成正常完成。

实现位置：[frontend/lib/llm/utils.ts:362](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/llm/utils.ts#L362)

---

## 6. 返回体格式

非流式返回是标准 OpenAI 结构，但有一个**非标准点：`usage` 里的数字是字符串**。

```json
{
  "usage": { "prompt_tokens": "8", "completion_tokens": "24", "total_tokens": "32" },
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": "1793250784",
  "model": "claude-sonnet-4-6",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }]
}
```

如果新项目要做 token 计费统计，记得 `Number(...)` 转一下。

---

## 7. 模型清单

`GET /api/openai/v1/models` 带鉴权返回，实测 292 个模型。本仓库维护了一份"显示名 → 规范 ID"的别名映射，原因见下。

**注意**：列表里同一个模型可能以多种写法出现（带空格的人类可读名 + 规范 ID），例如：

| 列表里出现的写法 | 实际调用应使用的 ID |
| --- | --- |
| `Claude Sonnet 4.5` / `claude-4.5-sonnet` | `claude-sonnet-4-6`（当前推荐） |
| `Claude Opus 4.6` | `claude-opus-4-6` |
| `Claude Opus 4.8` | `claude-opus-4-8` |
| `Doubao-Seedream-4.0` | `doubao-seedream-4-0-250828` |

本仓库当前推荐配置（按场景分模型），见 [frontend/lib/llm/settings.ts:89](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/llm/settings.ts#L89)：

```ts
// 默认/通用、作业批阅、注入提取
default / homeworkReview / trainingInject: "claude-sonnet-4-6"
// 评测、优化
evaluation / trainingOptimize:               "claude-opus-4-6"
// 训练配置生成（长文本、质量优先）
trainingGenerate:                            "claude-opus-4-8"
```

完整别名映射表在 [frontend/lib/config.ts:176](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/config.ts#L176)，下拉候选在 [frontend/lib/config.ts:202](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/config.ts#L202)。

模型目录拉取 + 失败回退逻辑：[frontend/lib/model-catalog.ts:9](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/model-catalog.ts#L9)（线上拉不到时降级到硬编码列表并缓存 60s）。

---

## 8. 生图接口（可选）

如果新项目也要生成封面/背景图，网关支持 OpenAI Images 兼容协议：

```bash
curl -sS https://llm-service.polymas.com/api/openai/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "api-key: $LLM_API_KEY" \
  -d '{
    "model": "doubao-seedream-5-0-260128",
    "prompt": "专业写实教学场景背景图，16:9，无文字",
    "size": "2560x1440",
    "response_format": "url",
    "sequential_image_generation": "disabled",
    "watermark": true
  }'
```

要点：
- 返回取 `data[0].url`，也可能是 `b64_json`，两种情况都要处理。
- `doubao-seedream-*` 用 `size` + `response_format: "url"`；`dall-e-3` 只支持 `1024x1024 / 1792x1024 / 1024x1792`。
- 仓库里的地址常量与降级顺序：[frontend/lib/training-injector/api.ts:51-62](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/training-injector/api.ts#L51)（正式网关 → beta 网关 → 火山方舟官方）。
- 生图还可以从 chat 地址直接推导：把 `/chat/completions` 替换为 `/images/generations`（[frontend/lib/training-injector/api.ts:664](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/training-injector/api.ts#L664)）。
- `gpt-image-1.5`、`gemini-2.5-flash-image`、`qwen-image-plus` 也在模型列表里，可直接换 model 试。

---

## 9. 本仓库的环境变量约定

| 变量 | 用在哪 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | 前端服务端 + Python 批阅服务 | 必需 |
| `LLM_BASE_URL` / `LLM_API_URL` | 前端用前者，Python 用后者 | 完整 chat 地址，也接受裸 base（代码会补 `/chat/completions`） |
| `LLM_MODEL` | 默认模型 | 前端默认 `gpt-4o`，Python 默认 `claude-sonnet-4-6` |
| `LLM_MODELS_URL` | 可选 | 覆盖模型目录地址 |
| `ARK_API_KEY` | 生图直连火山方舟 | 与 `LLM_API_KEY` 相同值 |
| `EMBEDDING_API_KEY` | 向量模型 | 同 key |

- 配置文件：根 [`.env`](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/.env)、[frontend/.env.local](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/.env.local)
- 模板：[frontend/.env.example](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/.env.example)、[homework_review/.env.example](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/homework_review/.env.example)
- 根 `.env` 里的 `MODEL_TYPE`、`USE_POST_API`、`LLM_SERVICE_CODE` 已确认**全仓库无引用**，是历史遗留，可忽略。
- 前端还支持在浏览器里覆盖配置并存 localStorage（键 `llm-eval-settings`），实现见 [frontend/lib/llm/settings.ts:181](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/lib/llm/settings.ts#L181)。

---

## 10. 连通性自检

新项目接完后，先跑这个判断是"网络问题"还是"key/参数问题"：

```bash
curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 30 \
  -X POST https://llm-service.polymas.com/api/openai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "api-key: $LLM_API_KEY" \
  -d '{"model":"gpt-4o","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
```

期望 `200`，实测往返约 1.4s。本仓库对应的自检路由：[frontend/app/api/llm-test/route.ts](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/frontend/app/api/llm-test/route.ts)（30s 超时，返回 endpoint / latencyMs / status）。

常见错误含义：

| 现象 | 原因 |
| --- | --- |
| 500 + `Required header 'api-key' is not present` | 没发鉴权头 |
| 超时 / fetch failed | 地址不可达或网络受限（换 HTTPS、查代理） |
| `model` 不存在 | 用了显示名（如 `Claude Sonnet 4.5`），换成规范 ID |
| gpt-5 / o 系列 400 | 带了 `temperature` 或用了 `max_tokens` |
| 长文本 500/503 + `aigateway_error` | 网关上游通道问题，保留返回里的 `requestId` 找服务方查（见 [docs/llm-gateway-opus5-diagnosis-2026-10-16.md](file:///Users/w/%E6%99%BA%E6%85%A7%E6%A0%91/%E8%87%AA%E5%8A%A8%E5%8C%96%E8%AE%BE%E8%AE%A1/%E5%B7%A5%E4%BD%9C%E6%B5%81%E6%99%BA%E8%83%BD%E4%BD%93%E8%AF%84%E6%B5%8Bagent/test_agent/Agent_Evaluation/docs/llm-gateway-opus5-diagnosis-2026-10-16.md)） |

---

## 11. 新项目接入清单

1. 复制 key：根 `.env` 的 `LLM_API_KEY`（第 12 行）。
2. 设 `LLM_BASE_URL=https://llm-service.polymas.com/api/openai/v1/chat/completions`。
3. 用 OpenAI 兼容 SDK，或直接 fetch，鉴权头同时发 `api-key` 和 `Bearer`。
4. 模型 ID 用规范写法（`gpt-4o` / `claude-sonnet-4-6` / `deepseek-v4-pro`），不要用带空格的显示名。
5. 需要流式时按第 5 节解析 `message.content`，不要依赖 `[DONE]`。
6. 长文档生成前先跑第 10 节自检，并把超时设到 60s 以上（仓库非流式是 180s，流式不设总超时）。
