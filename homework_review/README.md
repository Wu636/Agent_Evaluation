# 作业批阅系统集成文档

## 功能概述

本系统提供**自动化作业批阅**功能，支持：
- **云端 OCR 解析** + **LLM 智能校验**（A+B 方案）
- **作业批阅 Skills 批量测试**，支持多份学生作业、多次重复批阅和稳定性统计
- **AgentEval LLM 自动生成作业批阅 Skill ZIP**，支持从题目、评分标准、教师说明和教师样本一键生成
- **作业批阅 Skill 技能包接入**，上传后自动校验、切换为批阅类型并回填测试配置
- **AI 生成匿名学生 DOCX 测试作业**，自动覆盖多个质量档位并加入 Skills 批量测试
- 批量处理 Word 文档作业
- 多次评测并生成统计数据
- 自动生成 Excel 评分表（含均值、方差）
- 单次提交最多 150 份作业，支持分包/分片上传和后台队列

## 核心文件

| 文件 | 说明 |
|------|------|
| `homework_reviewer_v2.py` | 主程序，批阅流程控制 |
| `llm_answer_corrector.py` | LLM 答案校验模块 |
| `local_parser.py` | 本地 Word 解析模块（备用） |
| `skill_review_service.py` | Skills 附件上传、批阅执行、报告轮询与结果标准化 |
| `skill_generation_service.py` | AgentEval LLM 调用、Skill 蓝图校验、ZIP 组装与学生 DOCX 生成 |
| `main.py` | Web API 与传统 / Skills 异步批阅任务调度 |
| `review_job_control.py` | Supabase 登录校验、任务归属和跨用户公平并发控制 |
| `.env.example` | 环境变量配置示例 |
| `requirements.txt` | Python 依赖包列表 |

## 依赖项

```bash
pip install -r requirements.txt
```

主要依赖：
- `python-docx` - Word 文档解析
- `openpyxl` - Excel 生成
- `requests` - API 调用
- `python-dotenv` - 环境变量管理

## 环境配置

创建 `.env` 文件，配置以下变量：

```ini
# 智慧树平台认证
AUTHORIZATION=your_authorization_token
COOKIE=your_cookie_string
INSTANCE_NID=your_instance_nid

# LLM API 配置（用于答案校验、Skill ZIP 与学生作业生成）
LLM_API_KEY=your_llm_api_key
LLM_API_URL=http://llm-service.polymas.com/api/openai/v1/chat/completions
LLM_MODEL=your_llm_model

# AgentEval 登录校验（与前端使用同一个 Supabase 项目）
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
# 旧版 HS256 项目可选；未配置时通过 Supabase Auth API 校验
SUPABASE_JWT_SECRET=
```

## 使用方式

### 基本用法

```bash
cd homework_review
python homework_reviewer_v2.py
```

### 交互式选项

1. **上传方式**：选择单文件或文件夹
2. **测评次数**：每个文档测评次数（默认 5 次）
3. **报告格式**：JSON 或 PDF
4. **解析模式**：
   - 云端解析（推荐）- 自动 LLM 校验
   - 本地解析（备用）

### 输出结果

```
review_results/
├── 学生1/
│   ├── analysis.json       # 解析结果
│   ├── attempt_01.json     # 第1次批改
│   ├── attempt_02.json     # 第2次批改
│   └── ...
├── 学生2/
│   └── ...
└── 评分表.xlsx             # 汇总统计
```

## 核心功能

### 1. 云端解析 + LLM 校验（A+B 方案）

```
Word 文档 → 云端 API 解析 → 检测空白答案 → LLM 补充 → 批改
              ↓                              ↑
        (获取 itemName)              (用 Claude 修复)
```

**优势**：
- 云端 API 提供正确的题目匹配（`itemName`）
- LLM 自动补充 OCR 漏识别的答案
- 准确率高，稳定性好

### 2. 评分表统计

评分表包含：
- **总分**（含满分值）
- **分类得分**（选择题、判断题等）
- **维度得分**（每个评分维度）
- **均值** - 多次测评的平均分
- **方差** - 测评稳定性指标

**排序**：按等级顺序输出（优秀 → 良好 → 中等 → 合格 → 较差）

### 3. 重试机制

- **解析重试**：最多 3 次，间隔 2 秒
- **批改重试**：SSL/网络错误自动重试 3 次，间隔 3 秒

## 集成注意事项

### 1. API 配置

确保 `.env` 文件中的认证信息有效：
- `AUTHORIZATION` 和 `COOKIE` 需要定期更新（智慧树平台登录后获取）
- `INSTANCE_NID` 需要对应当前作业批阅任务；填错会导致平台返回“智能体配置错误”

### 2. 文件命名规范

建议学生答案文件命名包含等级关键词，方便自动排序：
- `等级一_优秀_学生答案.docx`
- `等级二_良好_学生答案.docx`
- `等级三_中等_学生答案.docx`
- `等级四_合格_学生答案.docx`
- `等级五_较差_学生答案.docx`

### 3. LLM 模型配置

默认使用 `claude-sonnet-4-20250514`，可在 `llm_answer_corrector.py` 中修改：

```python
payload = {
    "model": "claude-sonnet-4-20250514",  # 修改此处
    "temperature": 0.1,
    ...
}
```

### 4. 用户隔离与并发控制

默认最大并发数为 5，服务端硬上限为 10。文件数只表示队列长度，不会自动放大并发：

```python
asyncio.run(run_batch(..., max_concurrency=10))
```

Web 端大批量任务使用短请求异步流程：

1. `POST /api/review/jobs` 创建任务。
2. `POST /api/review/jobs/{job_id}/files` 分包上传小文件，或调用 `.../chunks` 分片上传大文件。
3. `POST /api/review/jobs/{job_id}/start` 进入后台队列。
4. `GET /api/review/jobs/{job_id}` 读取日志和最终汇总结果。

异步 Job 接口要求前端携带 Supabase Access Token。后端将 Job 绑定到令牌中的用户 ID，上传、启动、轮询、取消和结果下载都会复核归属；其他用户访问同一 Job ID 时按任务不存在处理。

单个 Railway 实例采用两层调度：

- 同一用户默认同时执行 1 个完整 Job，后续 Job 只进入该用户自己的队列。
- 不同用户的 Skills Job 可同时推进，不再共用“整批任务全局锁”。
- 每一次 Skills 批阅请求进入跨用户公平队列：全局默认 10 个名额、每用户默认 3 个名额，新加入的用户优先获得下一个释放的名额。
- 学生附件上传使用独立队列：全局默认 4 个名额、每用户默认 2 个名额。
- 传统批阅子进程使用独立的全局上限，默认 1 个，不占用 Skills 请求名额。

Railway 可通过以下环境变量按实例规格调节：

```ini
MAX_ACTIVE_REVIEW_JOBS_PER_USER=1
MAX_ACTIVE_TRADITIONAL_REVIEW_JOBS=1
MAX_GLOBAL_SKILL_ATTEMPTS=10
MAX_SKILL_ATTEMPTS_PER_USER=3
MAX_GLOBAL_SKILL_UPLOADS=4
MAX_SKILL_UPLOADS_PER_USER=2
REVIEW_AUTH_CACHE_SECONDS=60
```

当前 Job 状态与结果保存在单个服务进程和临时目录中，因此 Railway 保持 1 个副本。若以后扩成多个副本，需要先把 Job 状态、任务队列和结果文件迁移到共享存储。

### 5. 作业批阅 Skills 批量测试

Web 端在“作业批阅”页面选择“Skills 批阅测试”。自动化入口支持上传 DOCX、PDF、TXT、Markdown、CSV 或 XLSX 课程材料，也可以直接粘贴教师说明。系统使用 AgentEval 全局设置中的作业批阅模型：

1. 提取课程材料，生成结构化批阅蓝图。
2. 校验技能名、评分类型、分值合计、缺项规则和评价项；失败时将校验问题回送模型重生成。
3. 以“唯一根目录 + README.md + SKILL.md + references/”组装 ZIP，且在上传前再做一次平台合同校验。
4. 自动上传、设为批阅类型、回填预览链接与所有学生共用的作业要求。
5. 即使平台上传或类型转换失败，生成完成的 ZIP 仍保留在前端，可下载或点击手动重试。

平台测试配置需要：

- 同一登录会话的 `Authorization` 和 `Cookie`
- Skills 预览链接（会自动提取 `skillVersionId` 和 `skillNid`），或直接填写 `skillVersionId`
- 所有学生共用的 `submissionRequirement`：可手动填写，也可点击“AI 生成”从 Skill 概览自动生成后继续编辑
- 从平台 `GET /flow/bot/v1/list/model?scene=8` 加载并选择批阅模型
- 每份作业的评测次数与最大并发数

也可以直接选择生成器产出的课程作业批阅 Skill ZIP，点击“上传并接入测试”。系统自动执行：

1. 校验 ZIP 只有一个根目录，且根目录名与 `SKILL.md` frontmatter 的 `name` 一致。
2. 校验根目录包含 `README.md`、`SKILL.md`，只允许 `references/`、`scripts/`，阻止缓存、`agents/`、`assets/` 和模板占位内容。
3. 调用 `POST /ai-biz/v1/skill/create/unify/agentSkill`，使用 `type=2`、`source=BUILTIN` 上传。
4. 通过 `skill/cardList` 精确读取刚上传技能的中文名、描述、图标等原值。
5. 调用 `POST /ai-biz/v1/skill/metadata/save`，仅将 `typeTagId` 设为 `1`，保留其他元数据。
6. 自动回填 `skillNid`、`skillVersionId` 和预览链接，并尝试生成所有学生共用的作业要求；用户仍可修改后再开始批量测试。

其中 `cardList` 不承担测试或结果展示，只作为上传后保存类型时的元数据保护步骤，避免中文名、描述和图标被空值覆盖。

没有学生测试作业时，可在同一区域选择 1–5 份并点击“AI 生成并直接测试”。后端会按当前作业要求生成不同完成质量的简单 DOCX；档位仅用于内部测试覆盖，不写入文件名或作业正文。产物生成后直接进入学生作业列表，默认沿用当前模型、评测次数和并发配置立即开始 Skills 批量测试；取消勾选“生成完成后立即开始”可先检查文件再手动测试。

后台流程：

1. 每份学生作业只上传一次，记录返回的 OSS 附件地址。
2. 按“作业数 × 评测次数”创建独立 `taskId`，调用 `correction-skill/execute`。
3. 轮询 `correction-skill/report-detail`，直到 `reportStatus` 进入成功或失败终态。
4. 汇总总分、逐项得分、均值、方差，并展示综合评语、改进建议、数据验算明细与平台原始报告链接。


Skills 报告会持续轮询直到平台返回成功或失败终态，无固定超时上限；长时任务可通过页面的“取消批阅”手动终止。如果上一个页面的 Job ID 已丢失、新任务提示正在个人队列等待，可在批阅日志右上角点击“结束占用中的任务”。后端只取消当前账号最早的 `running` 任务，保留后面的 `queued` 任务并自动释放个人执行槽。

Skills 异步任务沿用同一套 Job 接口，将启动步骤换为：

```text
POST /api/review/jobs/{job_id}/start-skill
GET /api/review/jobs/active
DELETE /api/review/jobs/active
```

模型下拉框通过同源代理读取：

```text
POST /api/review/skill-models
```

“AI 生成作业要求”通过同源代理读取：

```text
POST /api/review/skill-overview
```

技能包上传与类型转换通过同源代理执行：

```text
POST /api/review/skill-package
```

AgentEval LLM 生成与自动上传、学生 DOCX 生成分别使用：

```text
POST /api/review/skill-package/generate
POST /api/review/student-samples/generate
```

后端调用平台 `POST /ai-biz/v1/correction-skill/overview`，将 Skill 描述、总分、逐项评分标准和评价输出项整理成可编辑文本。

后端使用同一组 `Authorization` 和 `Cookie` 请求平台的 `scene=8` 模型列表，优先选中 `defaultFlag=1` 的模型，并将模型 `code` 作为执行接口的 `modelName`。

任务结束后，`GET /api/review/jobs/{job_id}` 会在 `result.summary.engine` 返回 `skill`，并在 `result.scoreTable` 返回与传统批阅一致的统计结构。

### 6. 错误处理

- 解析失败的文件会被跳过，不影响其他文件
- LLM 校验失败会使用原始解析结果
- 批改失败会保存错误信息到 JSON

## 故障排查

### 问题 1：LLM 校验不工作

**检查**：
```bash
cd homework_review
python -c "from homework_reviewer_v2 import LLM_CORRECTOR_AVAILABLE; print(LLM_CORRECTOR_AVAILABLE)"
```

**解决**：确保 `llm_answer_corrector.py` 在同目录且 `LLM_API_KEY` 已配置

### 问题 2：批改返回"未找到该题"

**原因**：智慧树批改 API 后端题库配置问题

**解决**：联系平台技术支持，提供 `analysis.json` 和 `attempt_XX.json` 排查

### 问题 3：Excel 生成失败

**检查**：
```bash
pip list | grep openpyxl
```

**解决**：
```bash
pip install openpyxl
```

## API 参考

### homework_file_analysis(file_info, context)

云端解析 Word 文档

**返回**：`(success, analysis_result, text_input)`

### execute_agent_text(text_input, context)

调用批改 API

**返回**：`(success, result)`

### correct_answers_with_llm(docx_path, text_input)

LLM 答案校验

**返回**：修正后的 `text_input`

## 版本历史

- **v2.0** - 云端解析 + LLM 校验（A+B 方案）
- **v1.5** - 添加批改重试机制
- **v1.4** - 评分表添加均值、方差统计
- **v1.3** - 支持分类得分计算
- **v1.0** - 基础批改功能

## 技术支持

遇到问题请提供：
1. `analysis.json` - 解析结果
2. `attempt_XX.json` - 批改结果
3. 控制台输出日志

## License

Copyright © 2026 Skills Training Course Project
