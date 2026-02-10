# Railway 部署指南

## 📦 准备工作

已创建的文件：
- ✅ `api_server.py` - FastAPI服务入口
- ✅ `requirements.txt` - Python依赖
- ✅ `railway.json` - Railway配置
- ✅ `Procfile` - 启动命令
- ✅ `.env.example` - 环境变量模板

## 🚀 Railway 部署步骤

### 1. 创建Railway账号
访问 [railway.app](https://railway.app) 并用GitHub登录

### 2. 创建新项目

**方式A：从GitHub仓库部署（推荐）**
```bash
# 1. 确保代码已推送到GitHub
git add homework_review/
git commit -m "添加Railway部署配置"
git push origin main

# 2. 在Railway Dashboard：
# - 点击 "New Project"
# - 选择 "Deploy from GitHub repo"
# - 选择你的仓库
# - 选择 homework_review 作为根目录（Root Directory设置）
```

**方式B：使用Railway CLI**
```bash
# 安装Railway CLI
npm i -g @railway/cli

# 登录
railway login

# 在 homework_review 目录下初始化
cd homework_review
railway init

# 部署
railway up
```

### 3. 配置环境变量

在Railway项目设置中添加：

```env
# 智慧树平台认证（从你的 .env 复制）
AUTHORIZATION=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...
COOKIE=hike-polymas-identity=1; themeVariables=...
INSTANCE_NID=XLRNIzbkox

# LLM配置
LLM_API_KEY=sk-Js9xmWBzrIw5fZ6YlQ3PvUy7VaK2SHF9WciaMHHTK1f5WoR8
LLM_API_URL=http://llm-service.polymas.com/api/openai/v1/chat/completions
LLM_MODEL=claude-sonnet-4-20250514

# Railway会自动设置 PORT 变量
```

### 4. 设置Root Directory（重要！）

在Railway项目设置中：
1. 点击 Settings
2. 找到 "Root Directory"
3. 设置为 `homework_review`

这样Railway会从homework_review目录读取配置和代码。

### 5. 部署并获取URL

- Railway会自动检测Python并安装依赖
- 部署成功后会生成一个URL，例如：
  `https://your-app.railway.app`
- 在Settings中可以绑定自定义域名

## 🔗 前端集成

### 修改Vercel前端配置

在Vercel项目的环境变量中添加：

```env
NEXT_PUBLIC_HOMEWORK_API_URL=https://your-app.railway.app
```

然后前端API会自动调用Railway服务而不是本地spawn。

## 📊 监控和日志

Railway提供：
- ✅ 实时日志查看
- ✅ 资源使用监控（CPU、内存、网络）
- ✅ 部署历史
- ✅ 自动健康检查（访问 /health）

## 💰 费用说明

**Railway免费套餐：**
- $5/月免费额度
- 512MB内存
- 8个服务
- 无休眠（与Heroku不同）

**升级到Hobby计划（$5/月）：**
- 8GB内存
- 更多计算资源

## 🔧 本地测试

部署前可以本地测试：

```bash
cd homework_review

# 安装依赖
pip install -r requirements.txt

# 启动服务
python api_server.py

# 或使用uvicorn
uvicorn api_server:app --reload --port 8000

# 访问 http://localhost:8000
# 查看API文档：http://localhost:8000/docs
```

## 🐛 常见问题

### 1. 部署失败：找不到模块
确保 `requirements.txt` 包含所有依赖

### 2. 超时错误
- Railway默认请求超时300秒
- 如需更长时间，升级到Pro计划

### 3. 文件存储问题
- Railway临时文件系统每次部署会清空
- 生成的文件存储在 `/tmp` 下
- 定期清理避免磁盘占用

### 4. CORS错误
检查 `api_server.py` 中的 CORS配置是否包含你的Vercel域名

## 🔄 更新部署

```bash
# 修改代码后
git add .
git commit -m "更新功能"
git push origin main

# Railway会自动重新部署
```

## 📝 下一步

部署成功后，需要修改前端代码调用Railway API：
- 修改 `frontend/app/api/homework-review/generate/route.ts`
- 修改 `frontend/app/api/homework-review/route.ts`
- 将 `spawn` Python调用改为HTTP请求

需要我帮你修改前端代码吗？
