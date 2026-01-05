# 工作流智能体评测系统 (Agent Evaluation System)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Wu636/Agent_Evaluation)

## 项目简介

工作流智能体评测系统是一个专业的 LLM 驱动评估工具，专为教学和工作流导向的智能体设计。它能够自动分析智能体与用户的对话记录，依据教师文档（SOP）进行多维度评分，并生成详尽的诊断报告和**可直接落地的 Prompt 优化建议**。

本系统旨在解决传统人工评估耗时、标准不一且难以量化的问题，通过标准化、自动化的方式提升智能体的开发效率和交付质量。

## ✨ 核心功能

### 1. 多维度智能评估
系统基于 6 大核心维度进行全方位评估：
- **目标达成度 (40%)**：关键教学/任务环节是否完整覆盖（具有一票否决权）
- **策略引导力 (20%)**：是否采用引导式教学而非直接给出答案
- **流程遵循度 (15%)**：环节流转顺序是否符合 SOP 要求
- **交互体验感 (10%)**：对话是否自然、亲切，是否理解用户意图
- **幻觉控制力 (10%)**：是否严格遵循文档边界，无事实性错误
- **异常处理力 (5%)**：面对用户偏离话题或恶意输入时的应对能力

### 2. 自动化报告生成
- **雷达图可视化**：直观展示智能体在各维度的能力分布
- **逐项得分与分析**：提供每个维度的具体得分、定性评价及证据引用
- **关键问题列表**：自动提取对话中的严重问题（红色高亮）

### 3. 可落地的 Prompt 优化建议 🚀
系统不仅指出问题，还提供**直接可用的解决方案**：
- **分环节诊断**：精准定位到具体的工作流环节（如"环节3：检疫检测"）
- **具体规则生成**：生成可直接复制粘贴到 Prompt 中的规则文本
  - *示例*："在 Rules 中添加：**禁止重复**：请勿重复使用上一轮对话中完全相同的句子..."

### 4. 数据持久化与历史记录
- 支持 IndexedDB 本地存储，刷新页面不丢失数据
- 历史评估记录自动保存，方便对比优化效果

## 🚀 快速开始

### 1. 安装依赖

```bash
cd frontend
npm install
```

### 2. 配置环境变量

```bash
cp .env.template .env
# 编辑 .env 填写你的 API 密钥
```

必需的环境变量：
- `LLM_API_KEY` - LLM 服务 API 密钥
- `LLM_BASE_URL` - LLM API 地址（默认已配置）
- `LLM_MODEL` - 默认模型（推荐: `gpt-4o`）

### 3. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000 开始使用。

## 📋 使用流程

1. **上传文件**：
   - **教师文档** (PDF/Word/Txt)：定义标准的业务流程和知识库
   - **对话记录** (Txt/CSV)：智能体与用户的实际对话日志
   - **工作流配置** (Markdown)：(可选) 包含 Role/Profile/Rules/Workflow 的 Prompt 定义

2. **自动评估**：
   - 系统解析文件，构建结构化评估上下文
   - 调用 LLM (GPT-4o/Claude/Gemini) 进行流式分析
   - 实时生成各维度的评分和分析

3. **查看结果**：
   - 查看综合得分和评级（优秀/良好/合格/不合格）
   - 阅读详细的维度分析和问题定位
   - **复制优化建议**，直接迭代智能体 Prompt

## 🛠 技术栈

- **框架**: [Next.js 16](https://nextjs.org/) (App Router) + React 19 + TypeScript
- **样式**: [Tailwind CSS 4](https://tailwindcss.com/)
- **UI 组件**: [Lucide React](https://lucide.dev/) (图标), 自定义卡片组件
- **可视化**: [Recharts](https://recharts.org/) (雷达图)
- **文件处理**: [mammoth](https://github.com/mwilliamson/mammoth.js) (DOCX → Markdown)
- **存储**: [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) (客户端文件持久化)
- **AI 集成**: Fetch API (流式响应)

## 📁 项目结构

```
Agent_Evaluation/
├── frontend/                  # Next.js 全栈应用
│   ├── app/                   # Next.js App Router
│   │   ├── api/               # API 路由 (后端逻辑)
│   │   └── page.tsx           # 主页面
│   ├── components/            # React 组件
│   │   ├── EvaluationInterface.tsx  # 主评估界面
│   │   ├── ReportView.tsx     # 报告展示组件
│   │   └── ...
│   ├── lib/                   # 工具库
│   │   ├── llm/               # LLM 相关逻辑 (Prompts, Utils)
│   │   ├── file-storage.ts    # IndexedDB 存储
│   │   └── config.ts          # 项目配置
│   └── public/                # 静态资源
├── docs/                      # 文档
│   ├── USER_GUIDE.md          # 用户指南
│   ├── TROUBLESHOOTING.md     # 常见问题
│   └── 教师文档.md             # 示例文件
├── scripts/                   # 辅助脚本
└── README.md                  # 本文件
```

## 🚢 部署

### Vercel 部署（推荐）

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
| `/api/evaluate-stream` | POST | 流式评估（推荐） |
| `/api/models` | GET | 获取可用模型列表 |
| `/api/history` | GET | 获取评测历史记录 |
| `/api/history/[id]` | GET | 获取指定评测详情 |
| `/api/history/[id]` | DELETE | 删除指定评测记录 |

> **注意**：所有 API 端点由 Next.js API Routes 提供，无需单独的后端服务。

## ⚠️ 注意事项

### LLM 模型选择
- **推荐**：**GPT-4o** - 速度快（60-120秒），稳定性好
- **可用但慢**：Gemini-2.5-pro, Claude Sonnet - 响应时间长（240-420秒），可能超时

详见 [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)

### 数据隐私
所有上传的文件仅存储在浏览器本地 (IndexedDB) 和转发给 LLM 进行一次性评估，不会保存到任何服务器数据库中。

## 📚 更多文档

- **[用户指南](./docs/USER_GUIDE.md)** - 详细使用说明
- **[常见问题](./docs/TROUBLESHOOTING.md)** - 故障排除和模型选择

## 📝 许可证

MIT
