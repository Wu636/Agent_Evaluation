# LLM 评测系统 (Agent Evaluation)

一个用于评估 LLM 工作流智能体的 Web 应用系统。

## 📁 项目结构

```
Agent_Evaluation/
├── frontend/          # Next.js 全栈应用（包含前端和 API）
│   ├── app/          # Next.js App Router
│   │   └── api/      # API 路由
│   ├── lib/          # 核心逻辑库
│   │   ├── llm/      # LLM 评测模块
│   │   ├── converters/ # 文件转换器
│   │   └── *.ts      # 工具函数
│   └── components/   # React 组件
├── scripts/          # Python 命令行工具（可选）
├── data/             # 运行时数据（gitignore）
└── README.md         # 本文件
```

## 🚀 快速开始

### 1. 安装依赖

```bash
cd frontend
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env.local
# 编辑 .env.local 填写你的 API 密钥
```

必需的环境变量：
- `LLM_API_KEY` - LLM 服务 API 密钥
- `LLM_BASE_URL` - LLM API 地址（默认已配置）
- `LLM_MODEL` - 默认模型（默认: gpt-4o）

### 3. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000 开始使用。

## 🐳 Docker 部署

### 使用 Docker Compose（推荐）

```bash
# 1. 配置环境变量
cp .env.template .env
# 编辑 .env 填写你的 LLM_API_KEY

# 2. 构建并启动
docker-compose up -d --build

# 3. 查看日志
docker-compose logs -f

# 4. 关闭服务
docker-compose down
```

### 手动 Docker 部署

```bash
# 1. 构建镜像
cd frontend
docker build -t agent-evaluation .

# 2. 运行容器
docker run -d \
  --name agent-evaluation \
  -p 3000:3000 \
  -e LLM_API_KEY=your_key_here \
  -e LLM_BASE_URL=http://llm-service.polymas.com/api/openai/v1/chat/completions \
  -e LLM_MODEL=gpt-4o \
  -v $(pwd)/data:/app/data \
  agent-evaluation
```

## 📦 生产部署

### Vercel 部署

1. Fork 本项目到你的 GitHub
2. 在 [Vercel](https://vercel.com) 导入项目
3. 配置环境变量：
   - `LLM_API_KEY`
   - `LLM_BASE_URL`
   - `LLM_MODEL`
4. 部署

### 自建服务器部署

```bash
# 构建生产版本
cd frontend
npm run build

# 启动生产服务器
npm start
```

使用 PM2 保持服务运行：

```bash
npm install -g pm2
pm2 start npm --name "agent-evaluation" -- start
pm2 save
pm2 startup
```

## 🔧 API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/evaluate` | POST | 上传文件并执行评测 |
| `/api/models` | GET | 获取可用模型列表 |
| `/api/history` | GET | 获取评测历史记录 |
| `/api/history/[id]` | GET | 获取指定评测详情 |
| `/api/history/[id]` | DELETE | 删除指定评测记录 |

> **注意**：所有 API 端点由 Next.js API Routes 提供，无需单独的后端服务。

## 📚 评测维度

系统从 6 个维度评估 LLM 智能体：

1. **目标达成度** (40%) - 一票否决项，阈值 60 分
2. **策略引导力** (20%)
3. **流程遵循度** (15%)
4. **交互体验感** (10%)
5. **幻觉控制力** (10%)
6. **异常处理力** (5%)

## 🛠 技术栈

- **框架**: Next.js 16 + React 19 + TypeScript
- **样式**: Tailwind CSS 4
- **文件处理**: mammoth (DOCX → Markdown)
- **LLM 调用**: 原生 fetch API
- **数据存储**: JSON 文件

## 📚 更多文档

- **[📖 完整部署指南](./DEPLOYMENT.md)** - Docker 部署、本地开发、故障排除、数据管理
- **[快速开始指南](./docs/QUICK_START.md)** - 5 分钟快速上手
- **[LLM 评测指南](./docs/LLM_EVALUATION_GUIDE.md)** - 评测维度详解

## 📝 许可证

MIT
