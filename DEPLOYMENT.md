# 📚 LLM 评测系统 - 部署使用指南

完整的部署和管理指南，帮助您快速部署和使用 LLM 工作流智能体评测系统。

---

## 📋 目录

- [快速开始](#快速开始)
- [Docker 部署](#docker-部署)
- [本地开发](#本地开发)
- [常用命令](#常用命令)
- [数据管理](#数据管理)
- [故障排除](#故障排除)
- [生产部署](#生产部署)

---

## 🚀 快速开始

### 1. 环境要求

- Docker 20.10+
- Docker Compose 2.0+
- 8GB+ 可用内存

### 2. 配置环境变量

```bash
# 复制环境变量模板
cp .env.template .env

# 编辑配置文件，填写 LLM API 密钥
vim .env
```

必需配置：
```bash
LLM_API_KEY=your_api_key_here              # 必需
LLM_BASE_URL=http://llm-service...         # 可选，有默认值
LLM_MODEL=gpt-4o                            # 可选，默认 gpt-4o
```

### 3. 启动服务

```bash
# 使用部署脚本（推荐）
./deploy.sh start

# 或使用 docker-compose
docker-compose up -d --build
```

### 4. 访问应用

打开浏览器访问: **http://localhost:3000**

---

## 🐳 Docker 部署

### 方式一：使用部署脚本（推荐）

```bash
# 启动服务
./deploy.sh start

# 查看状态
./deploy.sh status

# 查看日志
./deploy.sh logs

# 停止服务
./deploy.sh stop
```

### 方式二：使用 Docker Compose

```bash
# 构建并启动
docker-compose up -d --build

# 查看日志
docker-compose logs -f

# 重启服务
docker-compose restart

# 停止服务
docker-compose down
```

### 手动 Docker 部署

```bash
# 构建镜像
cd frontend
docker build -t agent-evaluation .

# 运行容器
docker run -d \
  --name agent-evaluation \
  -p 3000:3000 \
  -e LLM_API_KEY=your_key_here \
  -e LLM_BASE_URL=http://llm-service.polymas.com/api/openai/v1/chat/completions \
  -v $(pwd)/data:/app/data \
  agent-evaluation
```

---

## 💻 本地开发

### 1. 安装依赖

```bash
cd frontend
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env.local
# 编辑 .env.local 配置 API 密钥
```

### 3. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

### 4. 构建生产版本

```bash
npm run build
npm start
```

---

## 🛠 常用命令

### 服务管理

| 命令 | 说明 |
|------|------|
| `./deploy.sh start` | 启动服务 |
| `./deploy.sh stop` | 停止服务 |
| `./deploy.sh restart` | 重启服务 |
| `./deploy.sh status` | 查看状态 |
| `./deploy.sh logs` | 查看日志 |
| `./deploy.sh logs --tail 50` | 查看最后 50 行 |
| `./deploy.sh build` | 重新构建 |
| `./deploy.sh build --no-cache` | 不使用缓存构建 |

### 容器管理

```bash
# 查看运行中的容器
docker ps

# 查看所有容器（包括停止的）
docker ps -a

# 进入容器
docker exec -it agent-evaluation sh

# 查看容器资源使用
docker stats agent-evaluation
```

### 镜像管理

```bash
# 查看镜像
docker images | grep agent

# 删除旧镜像
docker rmi agent_evaluation-app

# 清理未使用资源
docker system prune -a
```

---

## 💾 数据管理

### 数据存储位置

- **Docker 卷**: `agent_evaluation_agent-data`
- **挂载目录**: `./data` (项目根目录)
- **历史文件**: `evaluations_history.json`

### 备份数据

```bash
# 使用部署脚本备份
./deploy.sh backup

# 手动备份
docker run --rm \
  -v agent_evaluation_agent-data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/eval-backup-$(date +%Y%m%d).tar.gz /data
```

### 恢复数据

```bash
# 使用部署脚本恢复
./deploy.sh restore

# 手动恢复
docker run --rm \
  -v agent_evaluation_agent-data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar xzf /backup/eval-backup-20241223.tar.gz -C /
```

### 导出历史记录

```bash
# 从容器复制历史文件
docker cp agent-evaluation:/app/data/evaluations_history.json ./backup.json

# 查看历史记录
cat ./data/evaluations_history.json | jq '.'
```

---

## 🔍 故障排除

### 服务无法启动

**检查端口占用:**
```bash
lsof -i :3000
```

**清理旧容器:**
```bash
docker-compose down --remove-orphans
docker-compose up -d --build
```

### 查看详细日志

```bash
# 查看容器日志
docker-compose logs -f

# 查看 Next.js 应用日志
docker-compose logs -f app | grep "Next.js"
```

### API 调用失败

**检查环境变量:**
```bash
docker-compose exec app env | grep LLM
```

**测试 API 连接:**
```bash
docker-compose exec app sh -c "wget -qO- http://localhost:3000/api/models"
```

### 健康检查失败

容器显示 `unhealthy` 状态：

```bash
# 手动执行健康检查
docker-compose exec app wget -qO- http://localhost:3000/api/models

# 查看 Netlify 日志
docker-compose logs app | grep "Ready"
```

### 性能优化

```bash
# 限制内存使用
docker-compose up -d
docker update --memory="2g" agent-evaluation

# 清理 Docker 缓存
docker system prune -a --volumes
```

---

## 🚢 生产部署

### Vercel 部署（推荐）

1. **Fork 项目到 GitHub**

2. **在 Vercel 导入项目**

3. **配置环境变量:**
   ```
   LLM_API_KEY
   LLM_BASE_URL
   LLM_MODEL
   ```

4. **部署**

### 自建服务器部署

#### 使用 PM2（推荐）

```bash
# 构建应用
cd frontend
npm run build

# 安装 PM2
npm install -g pm2

# 启动应用
pm2 start npm --name "agent-evaluation" -- start

# 保存 PM2 配置
pm2 save

# 设置开机自启
pm2 startup
```

#### 使用 Systemd

```bash
# 创建服务文件
sudo vim /etc/systemd/system/agent-evaluation.service
```

```ini
[Unit]
Description=LLM Agent Evaluation System
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/agent-evaluation
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production
Environment=LLM_API_KEY=your_key
Environment=LLM_BASE_URL=http://llm-service...

[Install]
WantedBy=multi-user.target
```

```bash
# 启用并启动服务
sudo systemctl enable agent-evaluation
sudo systemctl start agent-evaluation

# 查看状态
sudo systemctl status agent-evaluation
```

### Nginx 反向代理

```nginx
server {
    listen 80;
    server_name eval.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 📊 监控和日志

### 查看应用指标

```bash
# 容器资源使用
docker stats agent-evaluation

# 磁盘使用
docker system df

# 日志分析
docker-compose logs app | grep "ERROR"
```

### 日志管理

```bash
# 限制日志大小
docker-compose up -d
docker update --log-opt max-size=10m --log-opt max-file=3 agent-evaluation

# 导出日志
docker-compose logs app > app-logs.txt
```

---

## 🔒 安全建议

1. **环境变量安全**
   - 不要将 `.env` 文件提交到 Git
   - 使用强密码和 API 密钥
   - 定期轮换 API 密钥

2. **容器安全**
   ```bash
   # 以非 root 用户运行（已在 Dockerfile 中配置）
   # 限制容器权限
   docker-compose up -d
   docker update --security-opt=no-new-privileges agent-evaluation
   ```

3. **网络安全**
   - 使用 HTTPS
   - 配置防火墙规则
   - 限制 API 访问

---

## 📞 获取帮助

- GitHub Issues: [项目地址]
- 文档: [README.md](./README.md)
- API 文档: 运行后访问 `/api/models`

---

## 📝 更新日志

- **2024-12**: 重构为 Next.js 全栈应用
- **2024-12**: 添加 Docker 部署支持
- **2024-12**: 添加中文化支持

---

**最后更新**: 2024年12月
