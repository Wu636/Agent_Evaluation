# Vercel环境变量配置

## 添加以下环境变量到Vercel项目

1. 进入 Vercel Dashboard → 你的项目 → Settings → Environment Variables

2. 添加：

```
HOMEWORK_API_URL=https://agentevaluation-production.up.railway.app
```

这样作业批阅页只会请求同源的 Vercel API。生成、批阅、远程预览和
下载都由 Vercel CDN 外部重写直接代理到 Railway。
国内用户的浏览器不再需要直连 `*.up.railway.app`。

## 说明

- ✅ `HOMEWORK_API_URL` 是仅服务端可见的环境变量，不会被打包进浏览器 JavaScript
- ✅ 生成、批阅、文件预览和下载全部经过同源 Vercel API
- ✅ 长时间 SSE 任务使用 CDN 外部重写，不占用 Vercel Function 的 300 秒执行时长
- ✅ 本地开发时如果不设置这个变量，会继续使用本地 Python 子进程

## 从旧配置迁移

代码暂时兼容旧的 `NEXT_PUBLIC_HOMEWORK_API_URL`，因此首次部署新代码时不会中断服务。
新版部署成功后，在 Vercel 中新增 `HOMEWORK_API_URL`，然后删除
`NEXT_PUBLIC_HOMEWORK_API_URL` 并再部署一次。
