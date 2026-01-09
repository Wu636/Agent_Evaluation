# 工作流智能体评测系统

## 🎯 近期重要更新 (2026-01-09)

### 🎨 UI/UX 全面升级 (2026-01-09)
1. **报告详情页重构**:
   - 右侧栏 **Sticky** 吸附，长报告阅读更从容
   - 移除无用的"综合分析"，替换为 **"优先改进建议"** (自动提取 Top 5 严重问题)
   - 侧边栏新增 **维度得分柱状图**（红绿灯配色，悬停显示详情，点击跳转）
   - 新增 **快速跳转导航**，长页面定位更便捷
2. **视觉优化**: 
   - 统一使用 **Indigo (靛青)** 高级配色
   - 优化柱状图样式：圆角、背景轨道、深色网格线

### ✨ 修复与改进
1. **Prompt 注入修复**: 彻底解决了 LLM 评估时无法获取文档内容的 Bug (模板字符串转义问题)
2. **Markdown 渲染**: 优化了 `judgment_basis` 字段的 Markdown 格式输出，提升阅读体验
3. **架构升级：客户端编排模式**
   - 解决 Vercel 60秒限制，采用并发 API 架构
   - 限制同时 5 个 LLM 调用，速度提升显著
4. **21 个子维度细化评估**: 全面覆盖目标、流程、交互、幻觉、教学等维度
5. **JSON 解析增强**: 集成 `jsonrepair`，大幅降低 LLM 输出格式错误率
6. **文件支持**: 新增 `.doc` 格式支持

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
- **推荐模型**: Claude 评估准确
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
