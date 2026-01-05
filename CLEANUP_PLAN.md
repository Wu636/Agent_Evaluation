# 项目目录整理方案

## 当前问题分析

### 1. 重复的文档
- `README.md` (根目录)
- `frontend/README.md`
- `DEPLOYMENT.md`
- `VERCEL_DEPLOYMENT.md`
- `docs/DEPLOYMENT_GUIDE.md`
- `docs/QUICK_START.md`

### 2. 重复的历史记录文件
- `evaluations_history.json` (根目录)
- `backend/evaluations_history.json`
- `data/evaluations_history.json`

### 3. 临时/测试文件
- `backend/temp_能力训练-工程热力学-制冷_converted.md`
- `.DS_Store`

### 4. 过时的后端代码
- `backend/` 目录（已迁移到 Next.js API Routes）
- `deploy.sh` (Docker 部署脚本，已使用 Vercel)
- `docker-compose.yml`

### 5. 配置文件冗余
- `.env.docker` (不再使用 Docker)
- `vercel.json` (根目录)
- `frontend/vercel.json`

---

## 整理方案

### 阶段 1：删除冗余文件 ✂️

**删除列表**：
```bash
# 1. 删除过时的后端
rm -rf backend/
rm -rf .venv/

# 2. 删除 Docker 相关
rm docker-compose.yml
rm deploy.sh
rm .env.docker

# 3. 删除重复的历史记录
rm evaluations_history.json
rm data/evaluations_history.json

# 4. 删除临时文件
rm .DS_Store
find . -name ".DS_Store" -delete

# 5. 删除冗余配置
rm vercel.json  # 保留 frontend/vercel.json
```

### 阶段 2：整合文档 📚

**保留并整合**：

1. **根目录保留**：
   - `README.md` - 项目主文档（需更新）
   - `PROJECT_INTRODUCTION.md` - 详细介绍
   - `.gitignore`
   - `.env.template`

2. **docs/ 目录整合**：
   ```
   docs/
   ├── USER_GUIDE.md          # 用户使用指南（保留）
   ├── DEPLOYMENT.md          # 合并所有部署文档
   ├── TROUBLESHOOTING.md     # 新增：常见问题（合并 GEMINI_CLAUDE_TIMEOUT.md）
   └── 教师文档.md             # 示例文件（保留）
   ```

3. **删除重复文档**：
   - `DEPLOYMENT.md` → 合并到 `docs/DEPLOYMENT.md`
   - `VERCEL_DEPLOYMENT.md` → 合并到 `docs/DEPLOYMENT.md`
   - `docs/DEPLOYMENT_GUIDE.md` → 合并到 `docs/DEPLOYMENT.md`
   - `docs/QUICK_START.md` → 合并到 `README.md`
   - `GEMINI_CLAUDE_TIMEOUT.md` → 移动到 `docs/TROUBLESHOOTING.md`
   - `PROMPT_OPTIMIZATION_TODO.md` → 删除（已完成）
   - `CLAUDE.md` → 删除（临时文件）

### 阶段 3：重组目录结构 📁

**最终目录结构**：
```
Agent_Evaluation/
├── .env.template              # 环境变量模板
├── .gitignore
├── README.md                  # 项目主文档
├── PROJECT_INTRODUCTION.md    # 详细介绍
│
├── docs/                      # 📚 所有文档
│   ├── USER_GUIDE.md          # 用户指南
│   ├── DEPLOYMENT.md          # 部署指南
│   ├── TROUBLESHOOTING.md     # 常见问题
│   └── 教师文档.md             # 示例文件
│
├── frontend/                  # 💻 Next.js 应用
│   ├── app/                   # Next.js App Router
│   ├── components/            # React 组件
│   ├── lib/                   # 工具库
│   ├── public/                # 静态资源
│   ├── package.json
│   ├── tsconfig.json
│   └── vercel.json
│
└── scripts/                   # 🛠️ 辅助脚本（如有）
```

---

## 执行步骤

### Step 1: 备份（安全第一）
```bash
# 创建备份分支
git checkout -b backup-before-cleanup
git push origin backup-before-cleanup
```

### Step 2: 删除文件
```bash
# 删除过时目录
git rm -rf backend/
git rm -rf .venv/

# 删除 Docker 文件
git rm docker-compose.yml deploy.sh .env.docker

# 删除重复文件
git rm evaluations_history.json
git rm -rf data/

# 删除临时文档
git rm CLAUDE.md PROMPT_OPTIMIZATION_TODO.md
```

### Step 3: 整合文档
```bash
# 移动文件到 docs/
mv GEMINI_CLAUDE_TIMEOUT.md docs/TROUBLESHOOTING.md

# 删除重复的部署文档（内容已合并）
git rm DEPLOYMENT.md VERCEL_DEPLOYMENT.md
git rm docs/DEPLOYMENT_GUIDE.md docs/QUICK_START.md
```

### Step 4: 更新 .gitignore
```gitignore
# 添加
.DS_Store
*.pyc
__pycache__/
.venv/
.env
.env.local
evaluations_history.json
```

### Step 5: 提交更改
```bash
git add .
git commit -m "chore: reorganize project structure

- Remove outdated backend/ and Docker files
- Consolidate duplicate documentation
- Clean up temporary files
- Simplify directory structure"
```

---

## 预期效果

**清理前**：24 个文件/目录（根目录）  
**清理后**：~10 个文件/目录（根目录）

**优点**：
- ✅ 目录结构清晰
- ✅ 文档不重复
- ✅ 易于维护
- ✅ 新用户容易理解
