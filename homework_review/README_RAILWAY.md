# 作业批阅 Railway 部署方案总结

## 🎯 解决方案概述

将作业批阅的Python后端部署到Railway，Vercel前端通过HTTP调用：

```
┌─────────────────┐
│  Vercel前端     │  
│  (Next.js)      │──HTTP──┐
└─────────────────┘        │
                           ▼
                  ┌──────────────────┐
                  │  Railway后端     │
                  │  (Python/FastAPI)│
                  │  - 生成答案      │
                  │  - 批阅评测      │
                  └──────────────────┘
```

## ✅ 已创建的文件

1. **`api_server.py`** - FastAPI服务
   - `/api/generate` - 生成学生答案
   - `/api/review` - 批阅评测
   - 流式SSE响应
   - CORS配置

2. **`requirements.txt`** - Python依赖
   - FastAPI + Uvicorn
   - 现有依赖保持不变

3. **`railway.json`** - Railway配置
   - 自动构建和部署
   - 健康检查配置

4. **`Procfile`** - 启动命令
   - Uvicorn服务器配置

5. **`DEPLOYMENT.md`** - 详细部署指南

## 🚀 快速开始

### 1. 提交代码到GitHub
```bash
git add homework_review/
git commit -m "添加Railway部署配置"
git push origin main
```

### 2. 在Railway部署

访问 [railway.app](https://railway.app)：
1. 登录GitHub
2. New Project → Deploy from GitHub
3. 选择仓库
4. **重要**：设置Root Directory为 `homework_review`
5. 添加环境变量（从 `.env` 复制）
6. 部署完成，获取URL

### 3. 配置Vercel前端

在Vercel项目添加环境变量：
```env
NEXT_PUBLIC_HOMEWORK_API_URL=https://your-app.railway.app
```

### 4. 修改前端代码

需要修改两个文件，将本地`spawn`改为HTTP调用：
- `frontend/app/api/homework-review/generate/route.ts`
- `frontend/app/api/homework-review/route.ts`

## 💡 优势对比

| 特性 | 本地运行 | Railway方案 |
|------|---------|------------|
| Vercel部署 | ❌ 不支持 | ✅ 完全支持 |
| Python环境 | ✅ 本地 | ✅ 云端 |
| 超时限制 | 无限制 | 300秒（可升级）|
| 成本 | 免费 | $5/月免费额度 |
| 多人访问 | ❌ 需本地运行 | ✅ 公网访问 |
| 自动扩展 | ❌ 单机 | ✅ 自动 |

## 📋 下一步行动

1. ✅ Railway部署配置已完成
2. ⏳ 部署到Railway并获取URL
3. ⏳ 修改前端代码调用远程API
4. ⏳ 测试完整流程

需要我帮你修改前端代码吗？
