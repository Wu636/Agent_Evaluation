# 在线项目预检部署

网页和后台 worker 要部署在同一版本。worker 不需要公网域名；它只轮询 Supabase 任务队列。

## 1. Supabase

在 Supabase SQL Editor 执行仓库根目录的 `supabase_project_publish_migration.sql`。迁移会创建 `project_publish_jobs`、`project_publish_revisions`、原子任务领取/排队 RPC，以及私有 bucket `project-publish-staging`。

检查项目的 Storage 全局文件大小限制不低于 200 MB。bucket 本身设置 200 MB 单文件上限；应用层另有 500 个文件、300 MB 项目总量和 24 小时任务有效期限制。临时源文件只通过限时签名上传/下载许可访问。

## 2. Vercel 网页

沿用现有 Supabase 环境变量，并新增服务端变量：

- `SUPABASE_SERVICE_ROLE_KEY`：Supabase service-role key。仅供 Next.js API 和 worker 的服务端运行环境读取，不能配置成 `NEXT_PUBLIC_*`。
- `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`：现有网页使用的 Supabase 项目地址和匿名 key。

Next API 根据当前 Supabase 登录会话绑定任务所有者；平台 Polymas Authorization/Cookie 仍只在用户点击确认发布后由浏览器现有上传流程使用。

## 3. 后台 worker

在 Railway 新建一个 Docker 服务，指向本仓库同一分支/提交：

- Build context：`frontend`
- Dockerfile：`Dockerfile.publish-worker`
- Start command：使用 Dockerfile 默认的 `node scripts/project-publish-worker.mjs`
- 不配置公网域名；先运行 1 个实例。单任务串行，队列领取由 Postgres 原子锁保护。
- 配置环境变量 `NEXT_PUBLIC_SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`，值与 Vercel 项目相同。
- 建议至少分配 2 vCPU、2 GB RAM。不要挂载包含其他服务密钥或业务数据的共享卷。

容器以 `node` 非 root 用户运行，Playwright 使用容器内 Chromium。巡检上下文只放行本地平铺预览地址，阻断其他 HTTP(S)、内网和 WebSocket 请求；项目浏览器拿不到 Supabase/Polymas 凭证。worker 会为运行中的任务续租，并每小时清理过期任务和暂存对象。

## 4. 同事如何使用

1. 登录 Agent Eval，在“资源上传 → HTML 项目发布”选择项目文件夹和入口 HTML。
2. 可选：展开“关键交互流程配置”，编辑已有的 `polymas-publish-flows.json`，或添加流程步骤。
3. 点击“开始在线预检”。文件通过 Supabase resumable upload 直接传入私有暂存区；关闭页面后，重新打开会恢复最近任务。上传中断时重新选择相同文件夹即可续传。
4. 查看逐页报告。唯一目标的大小写/相对路径问题会展示候选差异；勾选需要的修复后由服务端生成新版本并自动复检。
5. 复检通过后查看警告与覆盖范围，勾选确认框并点击“确认并发布”。此时才使用网页上方的 Polymas 上传凭证。系统逐个复用或上传资源、校验 OSS 地址，再登记入口链接。

缺素材、多候选路径和未覆盖交互会显示为待处理问题；系统不会猜测素材或业务含义。浏览器巡检为了隔离项目脚本而阻断外部网络，因此使用 CDN/API 的项目需要按提示确认外部依赖的实际线上表现。

## 5. 运行与维护

- 不需要同事安装 Node、Playwright、Codex 或 skill。
- 预检任务和临时文件默认保留 24 小时，worker 运行后会清理过期对象。worker 必须持续运行才能消费队列。
- 若任务长时间停留在“排队中”，先检查 Railway worker 是否启动、Supabase URL/service-role key 是否匹配，以及迁移中的 RPC 是否存在。
- 如浏览器文件直传遇到 CORS 错误，核对 `NEXT_PUBLIC_SUPABASE_URL` 指向浏览器可访问的 HTTPS Supabase 地址，并确认部署站点可对 Supabase Storage 发起 resumable upload 请求。
- 浏览器关闭后的“最近任务”指针保存在该浏览器本地；重新登录同一账号、使用同一浏览器可恢复任务。其他设备仍受 API 账号所有权校验保护。
