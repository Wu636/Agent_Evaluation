# 工作流智能体评测系统

## 🎯 近期重要更新 (2026-01-09)

### ✨ 架构升级：客户端编排模式
为解决 Vercel 60秒执行限制，重构为客户端编排架构：
- **原架构**: 单个 `/api/evaluate-stream` 处理全部 21 个子维度（耗时 3+ 分钟）
- **新架构**: 前端并发调用多个原子化 API
  - `/api/evaluate/parse` - 文件解析
  - `/api/evaluate/dimension` - 单个子维度评估
  - `/api/evaluate/history` - 保存历史记录
- **并发控制**: 限制同时 5 个 LLM 调用，显著提升评估速度

### 🔧 核心功能增强
1. **21 个子维度细化评估**: 从 6 个主维度扩展为 5 大维度 21 个子维度
2. **JSON 解析鲁棒性**: 集成 `jsonrepair` 自动修复 LLM 输出错误
3. **文件格式支持**: 新增 `.doc` 旧版 Word 文档支持
4. **Prompt 内容注入修复**: 修复关键 bug - 确保 LLM 接收实际文档内容而非空占位符
5. **移除冗余功能**: 移除未实现的工作流配置上传，简化界面

### 📋 评估维度（100分制）
- **目标达成度** (20分): 知识点覆盖率、能力覆盖率
- **流程遵循度** (20分): 环节准入条件、内部顺序、全局流转、准出检查、非线性跳转
- **交互体验性** (20分): 人设语言风格、表达自然度、上下文衔接、循环僵局、回复长度
- **幻觉与边界** (20分): 事实正确性、逻辑自洽性、未知承认、安全围栏、干扰抵抗
- **教学策略** (20分 - 加分项): 启发式提问、正向激励、纠错引导、深度追问

---

## 🚀 快速开始

### 1. 安装依赖
```bash
cd frontend
npm install
```

### 2. 配置环境变量
在 `frontend/.env.local` 中配置：
```env
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://api.openai.com/v1/chat/completions
LLM_MODEL=gpt-4o
```

### 3. 启动服务
```bash
npm run dev
```
访问 http://localhost:3000

## 📋 使用流程

1. **上传文件**
   - 教师文档: `.doc` | `.docx` | `.md` 
   - 对话记录: `.json` | `.txt`

2. **自动评估** - 并发调用 21 次 LLM API，实时显示进度

3. **查看报告** - 雷达图 + 详细分析 + Markdown 导出

## 🛠 技术栈
- **框架**: Next.js 16 (App Router) + React 19 + TypeScript
- **样式**: Tailwind CSS 4
- **可视化**: Recharts
- **文件处理**: mammoth (DOCX), word-extractor (DOC)
- **JSON 修复**: jsonrepair
- **存储**: IndexedDB (客户端) + JSON (服务端备份)

## 🚢 部署

### Vercel (推荐)
1. Fork 项目到 GitHub
2. 在 Vercel 导入并配置环境变量
3. 部署

### 自建服务器
```bash
npm run build
npm start
```

## ⚠️ 注意事项
- **推荐模型**: GPT-4o (快速稳定)
- **慢速模型**: Claude/Gemini (可能超时)
- **数据隐私**: 文件仅存储在浏览器本地，评估时一次性发送给 LLM

## � 项目结构
```
Agent_Evaluation/
├── frontend/
│   ├── app/api/         # API 路由
│   │   ├── evaluate/
│   │   │   ├── parse/       # 文件解析
│   │   │   ├── dimension/   # 单维度评估
│   │   │   └── history/     # 历史保存
│   ├── components/      # React 组件
│   ├── lib/             # 工具库
│   │   ├── llm/         # LLM 相关 (Prompts, Utils)
│   │   └── config.ts    # 配置
├── docs/                # 评分标准文档
└── generate_prompts.py  # Prompt 生成脚本
```

## 📝 许可证
MIT
