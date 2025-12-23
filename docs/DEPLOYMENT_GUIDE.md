# LLM 评测系统部署指南

本指南详细介绍如何将 Agent_Evaluation 项目部署到生产环境。

---

## 📋 部署前准备

### 必需项
- GitHub 账号（已有仓库：[Wu636/Agent_Evaluation](https://github.com/Wu636/Agent_Evaluation)）
- LLM API 密钥

### 项目结构
```
Agent_Evaluation/
├── frontend/          # Next.js 前端
├── backend/           # FastAPI 后端
├── docs/              # 文档
└── scripts/           # 工具脚本
```

---

## 🚀 方案一：Vercel + Railway（推荐）

### 优势
- ✅ 零配置部署，连接 GitHub 即可
- ✅ 自动 CI/CD，推送代码自动重新部署
- ✅ 免费额度充足
- ✅ 全球 CDN 加速

---

### 步骤 1：部署前端到 Vercel

#### 1.1 登录 Vercel
1. 访问 https://vercel.com
2. 点击 "Sign Up" 或 "Log In"
3. 选择 "Continue with GitHub"

#### 1.2 导入项目
1. 点击 "Add New..." → "Project"
2. 在 "Import Git Repository" 中找到 `Wu636/Agent_Evaluation`
3. 点击 "Import"

#### 1.3 配置项目
| 配置项 | 值 |
|--------|-----|
| **Project Name** | agent-evaluation（或自定义）|
| **Framework Preset** | Next.js（自动检测） |
| **Root Directory** | `frontend` |
| **Build Command** | `npm run build`（默认） |
| **Output Directory** | `.next`（默认） |

#### 1.4 配置环境变量
在 "Environment Variables" 中添加：

| Key | Value | 说明 |
|-----|-------|------|
| `NEXT_PUBLIC_API_URL` | `https://你的Railway后端URL` | 后端 API 地址，稍后配置 |

> ⚠️ 先跳过环境变量，部署后端后再回来更新

#### 1.5 部署
点击 "Deploy" 按钮，等待 2-3 分钟完成部署。

部署成功后会获得一个 URL，如：`https://agent-evaluation.vercel.app`

---

### 步骤 2：部署后端到 Railway

#### 2.1 登录 Railway
1. 访问 https://railway.app
2. 点击 "Login" → "Login with GitHub"

#### 2.2 创建项目
1. 点击 "New Project"
2. 选择 "Deploy from GitHub repo"
3. 选择 `Wu636/Agent_Evaluation` 仓库

#### 2.3 配置服务
在项目设置中配置：

| 配置项 | 值 |
|--------|-----|
| **Root Directory** | `backend` |
| **Start Command** | `uvicorn main:app --host 0.0.0.0 --port $PORT` |

#### 2.4 配置环境变量
在 "Variables" 中添加：

| Key | Value |
|-----|-------|
| `LLM_API_KEY` | 你的 LLM API 密钥 |
| `LLM_BASE_URL` | `http://llm-service.polymas.com/api/openai/v1/chat/completions` |
| `LLM_MODEL` | `gpt-4o` |

#### 2.5 生成公开 URL
1. 进入 "Settings" → "Networking"
2. 点击 "Generate Domain"
3. 获得 URL，如：`https://agent-evaluation-backend.railway.app`

#### 2.6 更新前端环境变量
回到 Vercel 项目：
1. 进入 "Settings" → "Environment Variables"
2. 更新 `NEXT_PUBLIC_API_URL` 为 Railway 后端 URL
3. 重新部署前端

---

### 步骤 3：验证部署

1. 访问前端 URL（Vercel 提供的地址）
2. 上传测试文件
3. 验证评估功能正常

---

## 🐳 方案二：Docker + 云服务器

适合需要完全控制的场景，如企业内网部署。

### 步骤 1：创建 Dockerfile

#### 后端 Dockerfile
在 `backend/` 目录下创建 `Dockerfile`：

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# 复制依赖文件
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制代码
COPY . .

# 复制 scripts 目录（llm_evaluation_agent.py 依赖）
COPY ../scripts /app/scripts

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

#### 前端 Dockerfile
在 `frontend/` 目录下创建 `Dockerfile`：

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# 构建时需要 API URL
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

# 生产镜像
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000

CMD ["node", "server.js"]
```

> 注意：需要在 `frontend/next.config.ts` 中添加 `output: 'standalone'`

### 步骤 2：创建 Docker Compose

在项目根目录创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  frontend:
    build:
      context: ./frontend
      args:
        NEXT_PUBLIC_API_URL: http://backend:8000
    ports:
      - "3000:3000"
    depends_on:
      - backend
    networks:
      - app-network

  backend:
    build:
      context: .
      dockerfile: ./backend/Dockerfile
    ports:
      - "8000:8000"
    environment:
      - LLM_API_KEY=${LLM_API_KEY}
      - LLM_BASE_URL=${LLM_BASE_URL}
      - LLM_MODEL=${LLM_MODEL}
    networks:
      - app-network

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - frontend
      - backend
    networks:
      - app-network

networks:
  app-network:
    driver: bridge
```

### 步骤 3：创建 Nginx 配置

在项目根目录创建 `nginx.conf`：

```nginx
events {
    worker_connections 1024;
}

http {
    upstream frontend {
        server frontend:3000;
    }

    upstream backend {
        server backend:8000;
    }

    server {
        listen 80;
        server_name your-domain.com;

        # 前端
        location / {
            proxy_pass http://frontend;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
        }

        # 后端 API
        location /api/ {
            proxy_pass http://backend/api/;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        }
    }
}
```

### 步骤 4：部署到服务器

```bash
# 1. 克隆代码
git clone https://github.com/Wu636/Agent_Evaluation.git
cd Agent_Evaluation

# 2. 创建环境变量文件
cat > .env << EOF
LLM_API_KEY=你的API密钥
LLM_BASE_URL=http://llm-service.polymas.com/api/openai/v1/chat/completions
LLM_MODEL=gpt-4o
EOF

# 3. 构建并启动
docker-compose up -d --build

# 4. 查看日志
docker-compose logs -f
```

---

## 📊 方案对比

| 特性 | Vercel + Railway | Docker + 云服务器 |
|------|------------------|-------------------|
| **部署难度** | ⭐ 简单 | ⭐⭐⭐ 中等 |
| **成本** | 免费起步 | 需服务器费用（约 ¥50-200/月）|
| **扩展性** | 自动扩展 | 需手动配置 |
| **控制权** | 受限于平台 | 完全控制 |
| **CI/CD** | 自动 | 需配置 |
| **适用场景** | 个人/测试/小团队 | 生产/企业/高安全要求 |

---

## 🔧 常见问题

### Q: 前端无法连接后端？
- 检查 `NEXT_PUBLIC_API_URL` 环境变量是否正确
- 确保后端已启动并可访问
- 检查 CORS 配置

### Q: Railway 部署失败？
- 确认 Root Directory 设置为 `backend`
- 检查 `requirements.txt` 是否完整
- 查看部署日志定位错误

### Q: Vercel 构建失败？
- 确认 Root Directory 设置为 `frontend`
- 检查 `package.json` 中的依赖是否正确
- 查看构建日志

---

## 📞 技术支持

如有问题，请查看：
- [快速开始指南](./QUICK_START.md)
- [LLM 评测指南](./LLM_EVALUATION_GUIDE.md)
- 项目仓库：https://github.com/Wu636/Agent_Evaluation
