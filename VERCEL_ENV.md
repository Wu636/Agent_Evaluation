# Vercel环境变量配置

## 添加以下环境变量到Vercel项目

1. 进入 Vercel Dashboard → 你的项目 → Settings → Environment Variables

2. 添加：

```
NEXT_PUBLIC_HOMEWORK_API_URL=https://agentevaluation-production.up.railway.app
```

这样前端会自动使用Railway的API而不是本地Python。

## 说明

- ✅ `NEXT_PUBLIC_` 前缀表示该变量可在客户端访问
- ✅ Railway自动重新部署后，前端会调用新的API端点
- ✅ 本地开发时如果不设置这个变量，会继续使用本地spawn Python
