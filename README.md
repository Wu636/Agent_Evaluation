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

## 🐳 Docker 部署

### 前置条件

- 安装 [Docker](https://www.docker.com/get-started)
- 安装 [Docker Compose](https://docs.docker.com/compose/install/)

### 启动服务

```bash
# 首次构建并启动（后台运行）
docker-compose up -d --build

# 仅启动服务（不重新构建）
docker-compose up -d

# 查看构建和启动日志
docker-compose up --build
```

### 查看服务状态和日志

```bash
# 查看所有容器状态
docker-compose ps

# 查看实时日志
docker-compose logs -f

# 只查看前端日志
docker-compose logs -f frontend

# 只查看后端日志
docker-compose logs -f backend
```

### 关闭服务

```bash
# 停止并删除容器（保留镜像和网络）
docker-compose down

# 停止并删除容器，同时删除镜像
docker-compose down --rmi all

# 停止并删除容器、镜像、卷（清理所有数据）
docker-compose down -v
```

### 服务地址

| 服务 | 地址 |
|------|------|
| 前端界面 | http://localhost:3000 |
| 后端 API | http://localhost:8000 |
| API 文档 | http://localhost:8000/docs |

### 常见问题

**端口被占用？**
```bash
# 查看占用端口的进程
lsof -i :3000
lsof -i :8000

# 或使用 docker-compose 跳过特定服务
docker-compose up -d backend  # 只启动后端
```

**重新构建镜像？**
```bash
docker-compose build --no-cache
docker-compose up -d
```

**直接使用脚本重构**
```bash
./rebuild.sh        # 重建所有服务（前端+后端）
./rebuild.sh -f     # 只重建前端
./rebuild.sh -b     # 只重建后端
./rebuild.sh -c     # 清理缓存后完全重建
```

## 📚 文档

- [快速开始指南](docs/QUICK_START.md)
- [LLM 评测指南](docs/LLM_EVALUATION_GUIDE.md)

## 🛠 技术栈

- **前端**: Next.js 16 + React 19 + TypeScript + Tailwind CSS
- **后端**: Python FastAPI + Uvicorn
