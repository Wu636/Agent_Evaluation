# 工作流智能体评测系统 (Agent Evaluation System)

## 项目简介

工作流智能体评测系统是一个专业的 LLM 驱动评估工具，专为致力于教学和工作流导向的智能体设计。它能够自动分析智能体与用户的对话记录，依据教师文档（Standard Operating Procedure, SOP）进行多维度评分，并生成详尽的诊断报告和可直接落地的优化建议。

本系统旨在解决传统人工评估耗时、标准不一且难以量化的问题，通过标准化、自动化的方式提升智能体的开发效率和交付质量。

## 核心功能

### 1. 多维度智能评估
系统基于 6 大核心维度进行全方位评估：
- **目标达成度 (40%)**：关键教学/任务环节是否完整覆盖（具有一票否决权）。
- **策略引导力 (20%)**：是否采用引导式教学而非直接给出答案。
- **流程遵循度 (15%)**：环节流转顺序是否符合 SOP 要求。
- **交互体验感 (10%)**：对话是否自然、亲切，是否理解用户意图。
- **幻觉控制力 (10%)**：是否严格遵循文档边界，无事实性错误。
- **异常处理力 (5%)**：面对用户偏离话题或恶意输入时的应对能力。

### 2. 自动化报告生成
- **雷达图可视化**：直观展示智能体在各维度的能力分布。
- **逐项得分与分析**：提供每个维度的具体得分、定性评价及证据引用。
- **关键问题列表**：自动提取对话中的严重问题（红色高亮）。

### 3. 可落地的 Prompt 优化建议 🚀
系统不仅指出问题，还提供**直接可用的解决方案**：
- **分环节诊断**：精准定位到具体的工作流环节（如"环节3：检疫检测"）。
- **具体规则生成**：生成可直接复制粘贴到 Prompt 中的规则文本。
  - *示例*："在 Rules 中添加：**禁止重复**：请勿重复使用上一轮对话中完全相同的句子..."

### 4. 数据持久化与历史记录
- 支持 IndexedDB 本地存储，刷新页面不丢失数据。
- 历史评估记录自动保存，方便对比优化效果。

## 业务流程

1. **配置上传**：
   - **教师文档** (PDF/Word/Txt)：定义标准的业务流程和知识库。
   - **对话记录** (Txt/CSV)：智能体与用户的实际对话日志。
   - **工作流配置** (Markdown)：(可选) 包含 Role/Profile/Rules/Workflow 的 Prompt 定义，用于生成精准建议。

2. **自动评估**：
   - 系统解析文件，构建结构化评估上下文。
   - 调用 LLM (GPT-4o/Claude/Gemini) 进行流式分析。
   - 实时生成各维度的评分和分析。

3. **结果展示**：
   - 查看综合得分和评级（优秀/良好/合格/不合格）。
   - 阅读详细的维度分析和问题定位。
   - **复制优化建议**，直接迭代智能体 Prompt。

## 技术架构

本项目采用现代化的前端技术栈，确保高性能和良好的用户体验。

### 技术栈
- **框架**: [Next.js 14](https://nextjs.org/) (App Router)
- **语言**: [TypeScript](https://www.typescriptlang.org/)
- **样式**: [Tailwind CSS](https://tailwindcss.com/) + [clsx](https://github.com/lukeed/clsx)
- **UI 组件**: [Lucide React](https://lucide.dev/) (图标), 自定义卡片组件
- **可视化**: [Recharts](https://recharts.org/) (雷达图)
- **存储**: [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) (客户端文件持久化)
- **AI 集成**: OpenAI SDK / Fetch API (流式响应)

### 架构设计

```mermaid
graph TD
    User[用户] --> UI[前端界面 (Next.js)]
    UI -->|上传文件| LocalDB[(IndexedDB)]
    
    UI -->|发起评估请求| API[API Route (/api/evaluate-stream)]
    
    subgraph "Serverless Function"
        API -->|1. 解析文档| Parser[文档解析器]
        Parser -->|2. 构建上下文| Builder[Prompt 构建器]
        Builder -->|3. 调用 LLM| LLM[大语言模型 (GPT-4o)]
        LLM -->|4. 流式返回| API
    end
    
    API -->|SSE 流式数据| UI
    UI -->|渲染报告| Report[可视化报告]
    UI -->|生成建议| Suggestion[Prompt 优化建议]
```

### 目录结构
```
frontend/
├── app/                  # Next.js App Router
│   ├── api/              # 后端 API 路由
│   └── page.tsx          # 主页面
├── components/           # React 组件
│   ├── EvaluationInterface.tsx  # 主评估界面
│   ├── ReportView.tsx    # 报告展示组件
│   └── ...
├── lib/                  # 工具库
│   ├── llm/              # LLM 相关逻辑 (Prompts, Utils)
│   ├── file-storage.ts   # IndexedDB 存储文件
│   └── config.ts         # 项目配置
└── public/               # 静态资源
```

## 部署说明

项目支持部署到 [Vercel](https://vercel.com/)。

1. **环境变量配置** (.env.local):
   ```
   LLM_API_KEY=sk-...
   LLM_BASE_URL=https://...
   LLM_MODEL=gpt-4o
   ```

2. **构建与运行**:
   ```bash
   npm install
   npm run build
   npm start
   ```

## 注意事项

- **LLM 模型选择**：推荐使用 **GPT-4o** 以获得最佳速度和稳定性。Gemini/Claude 模型可能会因响应时间较长导致 Vercel 函数超时（详见 `GEMINI_CLAUDE_TIMEOUT.md`）。
- **数据隐私**：所有上传的文件仅存储在浏览器本地 (IndexedDB) 和转发给 LLM 进行一次性评估，不会保存到任何服务器数据库中。
