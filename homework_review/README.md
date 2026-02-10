# 作业批阅系统集成文档

## 功能概述

本系统提供**自动化作业批阅**功能，支持：
- **云端 OCR 解析** + **LLM 智能校验**（A+B 方案）
- 批量处理 Word 文档作业
- 多次评测并生成统计数据
- 自动生成 Excel 评分表（含均值、方差）

## 核心文件

| 文件 | 说明 |
|------|------|
| `homework_reviewer_v2.py` | 主程序，批阅流程控制 |
| `llm_answer_corrector.py` | LLM 答案校验模块 |
| `local_parser.py` | 本地 Word 解析模块（备用） |
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
TASK_ID=your_task_id

# LLM API 配置（用于答案校验）
LLM_API_KEY=your_llm_api_key
LLM_API_URL=http://llm-service.polymas.com/api/openai/v1/chat/completions
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
- `TASK_ID` 需要对应正确的批阅任务

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

### 4. 并发控制

默认最大并发数为 5，可在调用时修改：

```python
asyncio.run(run_batch(..., max_concurrency=10))
```

### 5. 错误处理

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
