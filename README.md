# 工作流智能体评测系统

> 基于大语言模型的智能体教学对话质量评估工具，支持多维度自动化评分与详细报告生成

## ✨ 核心特性

### 🎯 全面评估体系
- **21 个细分维度**：覆盖目标达成、流程遵循、交互体验、幻觉控制、教学策略
- **100 分制评分**：量化评估结果，直观展示优劣势
- **智能建议生成**：自动提取问题并给出改进方案

### 🚀 技术亮点
- **流式响应**：采用 SSE 技术，突破 Vercel 60 秒超时限制
- **动态并发池**：智能调度 LLM 调用，评估速度提升 3-5 倍
- **实时进度反馈**：可视化展示评估进度，支持中途取消
- **云端存储**：集成 Supabase，支持多设备同步与分享

### 🎨 现代化 UI/UX
- **双输入模式**：支持文件上传或文本粘贴
- **交互式报告**：雷达图、折叠卡片、精准滚动定位
- **一键分享**：生成分享链接，支持公开/私有切换
- **Markdown 导出**：完整报告导出，便于存档与二次编辑

## 📋 评估维度（100 分制）

| 维度 | 分值 | 子维度 |
|------|------|--------|
| **目标达成度** | 20 分 | 知识点覆盖率、能力覆盖率 |
| **流程遵循度** | 20 分 | 环节准入、内部顺序、全局流转、准出检查、非线性跳转 |
| **交互体验性** | 20 分 | 人设语言风格、表达自然度、上下文衔接、循环僵局、回复长度 |
| **幻觉与边界** | 20 分 | 事实正确性、逻辑自洽性、未知承认、安全围栏、干扰抵抗 |
| **教学策略** | 20 分 | 启发式提问、正向激励、纠错引导、深度追问（加分项）|

## 🚀 快速开始

### 在线使用（推荐）
直接访问已部署的 Vercel 应用，无需安装：
```
https://your-app.vercel.app
```

### 本地开发

#### 1. 克隆项目
```bash
git clone <repository-url>
cd Agent_Evaluation/frontend
```

#### 2. 安装依赖
```bash
npm install
```

#### 3. 配置环境变量
创建 `frontend/.env.local` 文件：
```env
# LLM API 配置
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://api.openai.com/v1/chat/completions
LLM_MODEL=gpt-4o

# Supabase 配置（可选，用于云端存储）
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

#### 4. 启动开发服务器
```bash
npm run dev
```
访问 http://localhost:3000

## 📖 使用指南

详细使用说明请参考 [用户使用手册](./USER_MANUAL.md)

## 🛠 技术栈

- **前端框架**: Next.js 15 (App Router) + React 19 + TypeScript
- **样式方案**: Tailwind CSS 4
- **数据可视化**: Recharts
- **文件处理**: mammoth (DOCX), word-extractor (DOC)
- **JSON 修复**: jsonrepair
- **云端存储**: Supabase (PostgreSQL + Auth)
- **部署平台**: Vercel

## 🚢 部署

### Vercel 部署（推荐）

1. Fork 本项目到你的 GitHub
2. 在 [Vercel](https://vercel.com) 导入项目
3. 配置环境变量（同上）
4. 点击部署

### Docker 部署

```bash
docker build -t agent-eval .
docker run -p 3000:3000 --env-file .env.local agent-eval
```

## 📁 项目结构

```
Agent_Evaluation/
├── frontend/
│   ├── app/
│   │   ├── api/              # API 路由
│   │   │   ├── evaluate/     # 评估相关 API
│   │   │   ├── evaluations/  # 云端存储 API
│   │   │   └── auth/         # 认证回调
│   │   ├── explore/          # 公开报告广场
│   │   └── report/[id]/      # 分享报告页面
│   ├── components/           # React 组件
│   │   ├── EvaluationInterface.tsx  # 主界面
│   │   ├── ReportView.tsx           # 报告展示
│   │   ├── HistoryView.tsx          # 历史记录
│   │   └── FileUpload.tsx           # 文件上传
│   ├── lib/
│   │   ├── llm/              # LLM 相关
│   │   │   ├── prompts/      # 评估 Prompt
│   │   │   ├── evaluator.ts  # 评估逻辑
│   │   │   └── utils.ts      # LLM 调用工具
│   │   ├── supabase.ts       # Supabase 客户端
│   │   └── config.ts         # 配置文件
│   └── public/               # 静态资源
├── docs/                     # 评分标准文档
├── supabase_schema.sql       # 数据库表结构
└── README.md                 # 本文件
```

## 🔒 数据隐私

- **本地存储优先**：未登录用户的数据仅存储在浏览器本地（IndexedDB）
- **云端加密传输**：登录用户数据通过 HTTPS 加密传输至 Supabase
- **按需分享**：报告默认私有，用户可手动设置为公开
- **LLM 调用**：文件内容仅在评估时一次性发送给 LLM，不做持久化存储

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

## 📝 许可证

MIT License

## 📮 联系方式

如有问题或建议，请通过 Issue 或邮件联系。
