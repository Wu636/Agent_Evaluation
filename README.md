# LLM 评测系统 (Agent Evaluation)

一个用于评估 LLM 工作流智能体的 Web 应用系统。

## 📁 项目结构

```
Agent_Evaluation/
├── frontend/          # Next.js 前端应用
├── backend/           # FastAPI 后端服务
├── docs/              # 项目文档
├── scripts/           # 工具脚本（命令行版评测、配置向导）
├── data/              # 运行时数据（gitignore）
├── .env.template      # 环境变量模板
└── README.md          # 本文件
```

## 🚀 快速开始

### 1. 配置环境变量

```bash
cp .env.template .env
# 编辑 .env 填写你的 API 密钥
```

### 2. 启动后端

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
```

访问 http://localhost:3000 开始使用。

## 📚 文档

- [快速开始指南](docs/QUICK_START.md)
- [LLM 评测指南](docs/LLM_EVALUATION_GUIDE.md)

## 🛠 技术栈

- **前端**: Next.js 16 + React 19 + TypeScript + Tailwind CSS
- **后端**: Python FastAPI + Uvicorn
