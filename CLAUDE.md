# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供代码库操作指导。

## 项目概述

LLM 工作流智能体评测系统 - 通过分析教师文档和对话记录来评估 LLM 教学/培训智能体的 Web 应用。使用 GPT-4o（或兼容 LLM）在 6 个维度上进行语义分析并加权评分。

**技术栈：**
- 前端：Next.js 16 + React 19 + TypeScript + Tailwind CSS 4
- 后端：Python FastAPI + Uvicorn
- UI：Radix UI 组件，shadcn/ui 风格，Lucide 图标
- 3D/可视化：Three.js，Framer Motion，Recharts

## 常用命令

### 本地开发

```bash
# 后端 (端口 8000)
cd backend && pip install -r requirements.txt && uvicorn main:app --reload

# 前端 (端口 3000)
cd frontend && npm install && npm run dev
```

### Docker 部署

```bash
# 启动服务
docker-compose up -d

# 重新构建并启动
docker-compose up --build -d

# 查看日志
docker-compose logs -f

# 关闭服务
docker-compose down
```

### 服务地址
- 后端：`http://localhost:8000`
- 前端：`http://localhost:3000`
- API 文档：`http://localhost:8000/docs`

## 架构

```
前端 (Next.js) → HTTP POST /api/evaluate → FastAPI 后端
    ├── FileUpload.tsx                      ├── main.py (接口)
    ├── HistoryView.tsx   ────────────────→ ├── history_manager.py (JSON 存储)
    ├── ReportView.tsx                      └── scripts/llm_evaluation_agent.py
    └── lib/api.ts (API 客户端)
```

**主要 API 接口：**
- `POST /api/evaluate` - 上传文件并执行评测
- `GET /api/history` - 获取所有评测记录
- `GET/DELETE /api/history/{id}` - 获取/删除指定评测

**评测维度（6 个）：**
- teaching_goal_completion (40%，否决线: <60)
- teaching_strategy (20%)
- workflow_consistency (15%)
- interaction_experience (10%)
- hallucination_control (10%)
- robustness (5%)

## 代码规范

### 前端
- 客户端组件使用 `"use client"` 指令
- 路径别名：`@/components`，`@/lib`，`@/ui`
- Tailwind CSS 配合 class-variance-authority 实现多样式

### 后端
- FastAPI 配合 Pydantic 模型进行数据校验
- LLM 调用使用 `requests` 库（而非 OpenAI SDK）
- 环境变量配置在 `.env` 文件中

### 配置项
必需的环境变量：
- `LLM_API_KEY` - LLM 服务 API 密钥
- `LLM_BASE_URL` - LLM API 基础 URL（默认：`http://llm-service.polymas.com/api/openai/v1/chat/completions`）
- `LLM_MODEL` - 模型名称（默认：`gpt-4o`）

## 文件上传格式

支持 `.docx`、`.md` 格式的教师文档和 `.json`、`.txt` 格式的对话记录。后端的 `txt_to_json_converter.py` 负责处理 TXT 到 JSON 的转换。
