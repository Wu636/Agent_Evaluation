# 🚀 Vercel 部署指南

将 LLM 评测系统部署到 Vercel 平台的完整指南。

---

## 📋 前置要求

- GitHub 账号（项目已托管）
- Vercel 账号（可用 GitHub 登录）
- LLM API 密钥

---

## 🚀 快速部署

### 方式一：通过 Vercel 网站部署（推荐）

#### 1. 导入项目到 Vercel

1. 访问 [Vercel](https://vercel.com)
2. 点击 "Add New..." → "Project"
3. 导入 GitHub 仓库：`Wu636/Agent_Evaluation`
4. 选择分支：**rebuild_by_nextjs**

#### 2. 配置项目

**项目设置：**
```
Framework Preset: Next.js
Root Directory: ./frontend
Build Command: npm run build
Output Directory: (保持默认)
Install Command: npm install
```

#### 3. 配置环境变量（必需）

在 Vercel 项目设置中添加以下环境变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `LLM_API_KEY` | `your_api_key_here` | LLM 服务 API 密钥（必需） |
| `LLM_BASE_URL` | `http://llm-service.polymas.com/api/openai/v1/chat/completions` | LLM API 地址 |
| `LLM_MODEL` | `gpt-4o` | 默认模型 |

**添加步骤：**
1. 在项目配置页面找到 "Environment Variables"
2. 逐个添加上述环境变量
3. 选择适用的环境（Production, Preview, Development）
4. 点击 "Save"

#### 4. 部署

点击 "Deploy" 按钮，等待构建完成（约 2-3 分钟）。

---

### 方式二：使用 Vercel CLI

#### 1. 安装 Vercel CLI

```bash
npm install -g vercel
```

#### 2. 登录 Vercel

```bash
vercel login
```

#### 3. 部署项目

```bash
cd frontend
vercel
```

按照提示操作：
- ? Set up and deploy? **Y**
- ? Which scope? **选择你的账号**
- ? Link to existing project? **N** (首次部署)
- ? What's your project's name? **agent-evaluation**
- ? In which directory is your code? **.** (当前目录)
- ? Want to override settings? **N**

#### 4. 配置环境变量

```bash
# 添加环境变量
vercel env add LLM_API_KEY
vercel env add LLM_BASE_URL
vercel env add LLM_MODEL

# 为生产环境设置
vercel env add LLM_API_KEY production
```

#### 5. 正式部署

```bash
# 部署到生产环境
vercel --prod
```

---

## ⚙️ 部署后配置

### 自定义域名

1. 在 Vercel 项目中点击 "Settings" → "Domains"
2. 添加自定义域名
3. 按照提示配置 DNS 记录

### 环境变量管理

```bash
# 查看所有环境变量
vercel env ls

# 删除环境变量
vercel env rm LLM_API_KEY

# 拉取最新环境变量到本地
vercel env pull .env.local
```

---

## 🔍 验证部署

部署完成后，检查以下功能：

### 1. 访问应用

打开 Vercel 提供的域名（如 `https://agent-evaluation.vercel.app`）

### 2. 测试 API

```bash
# 测试模型列表 API
curl https://your-domain.vercel.app/api/models

# 测试健康检查
curl https://your-domain.vercel.app/api/models
```

### 3. 查看部署日志

在 Vercel 控制台：
1. 进入项目
2. 点击 "Deployments"
3. 选择最新部署
4. 查看 "Build Logs" 和 "Runtime Logs"

---

## 📊 监控和调试

### 查看函数日志

```bash
vercel logs
```

### 实时日志

```bash
vercel logs --follow
```

### 查看部署状态

```bash
vercel ls
```

---

## 🛠 常见问题

### 1. 构建失败

**问题**：构建时出现 TypeScript 错误

**解决方案**：
```bash
# 本地测试构建
cd frontend
npm run build

# 检查错误
npm run lint
```

### 2. API 调用失败

**问题**：API 返回 500 错误

**解决方案**：
- 检查环境变量是否正确配置
- 在 Vercel 控制台查看运行时日志
- 确认 LLM API 密钥有效

### 3. 文件上传失败

**问题**：上传大文件时超时

**解决方案**：
Vercel 免费版有 10 秒超时限制，升级到 Pro 版可解决。

### 4. 数据持久化

**注意**：Vercel 是无状态的，历史记录数据需要外部存储。

**推荐方案**：
- 使用 Vercel Postgres
- 使用外部数据库（如 Supabase、PlanetScale）
- 或实现客户端存储（localStorage）

---

## 🔄 持续部署

配置自动部署后，每次推送到 `rebuild_by_nextjs` 分支会自动触发部署。

### 配置自动部署

在 Vercel 项目设置中：
1. "Git" → "Branches"
2. 选择 "rebuild_by_nextjs" 分支
3. 启用自动部署

### 部署钩子

```bash
# 部署前执行
vercel env add PRE_BUILD_HOOK

# 部署后执行
vercel env add POST_BUILD_HOOK
```

---

## 📝 环境变量说明

### 必需变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `LLM_API_KEY` | LLM API 密钥 | `sk-xxx...` |
| `LLM_BASE_URL` | API 基础 URL | `http://llm-service.polymas.com/...` |
| `LLM_MODEL` | 默认模型 | `gpt-4o` |

### 可选变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATA_DIR` | 数据目录 | `/app/data` |
| `HISTORY_FILE` | 历史文件名 | `evaluations_history.json` |

---

## 🔒 安全建议

1. **不要提交敏感信息**
   - ✅ 提交 `.env.example`
   - ❌ 不要提交 `.env.local`

2. **使用环境变量**
   - API 密钥通过 Vercel 环境变量配置
   - 不同环境使用不同的密钥

3. **定期轮换密钥**
   - 定期更新 LLM_API_KEY
   - 在 Vercel 控制台更新环境变量

---

## 📞 获取帮助

- Vercel 文档: https://vercel.com/docs
- Next.js 部署: https://vercel.com/deployments/nextjs
- GitHub Issues: https://github.com/Wu636/Agent_Evaluation/issues

---

**最后更新**: 2024年12月
