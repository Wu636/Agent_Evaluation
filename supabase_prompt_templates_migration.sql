-- Prompt 模板市场 - 迁移脚本
-- 执行位置：Supabase Dashboard > SQL Editor
-- 允许用户创建、保存、公开分享训练配置 Prompt 模板和评分标准 Prompt 模板

-- 1. 创建 prompt_templates 表
CREATE TABLE IF NOT EXISTS prompt_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,

    -- 基础信息
    name TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL CHECK (type IN ('script', 'rubric')),

    -- 模板内容（含 {teacherDoc} 占位符）
    prompt_template TEXT NOT NULL,
    system_prompt TEXT,

    -- 元信息
    is_public BOOLEAN DEFAULT FALSE,
    is_default BOOLEAN DEFAULT FALSE,
    use_count INTEGER DEFAULT 0,
    tags TEXT[] DEFAULT '{}',

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 创建索引
CREATE INDEX IF NOT EXISTS idx_prompt_templates_user_id ON prompt_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_type ON prompt_templates(type);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_is_public ON prompt_templates(is_public);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_is_default ON prompt_templates(is_default);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_use_count ON prompt_templates(use_count DESC);

-- 3. 启用 RLS
ALTER TABLE prompt_templates ENABLE ROW LEVEL SECURITY;

-- 4. RLS 策略

-- 用户可以查看自己的模板
CREATE POLICY "Users can view own prompt templates"
ON prompt_templates FOR SELECT
USING (auth.uid() = user_id);

-- 用户可以查看公开模板
CREATE POLICY "Public prompt templates are viewable by all"
ON prompt_templates FOR SELECT
USING (is_public = TRUE);

-- 用户可以查看系统默认模板 (user_id = NULL)
CREATE POLICY "Default prompt templates are viewable by all"
ON prompt_templates FOR SELECT
USING (user_id IS NULL AND is_default = TRUE);

-- 用户可以创建自己的模板
CREATE POLICY "Users can create own prompt templates"
ON prompt_templates FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- 用户可以更新自己的模板
CREATE POLICY "Users can update own prompt templates"
ON prompt_templates FOR UPDATE
USING (auth.uid() = user_id);

-- 用户可以删除自己的模板
CREATE POLICY "Users can delete own prompt templates"
ON prompt_templates FOR DELETE
USING (auth.uid() = user_id);

-- 5. 更新时间戳触发器
CREATE OR REPLACE FUNCTION update_prompt_template_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_prompt_template_timestamp ON prompt_templates;
CREATE TRIGGER trigger_update_prompt_template_timestamp
    BEFORE UPDATE ON prompt_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_prompt_template_timestamp();

-- 6. 使用计数原子递增 RPC
CREATE OR REPLACE FUNCTION increment_prompt_template_use_count(template_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE prompt_templates
    SET use_count = use_count + 1
    WHERE id = template_id;
END;
$$;

-- 7. 插入系统默认模板 - 训练剧本配置
INSERT INTO prompt_templates (id, user_id, name, description, type, prompt_template, system_prompt, is_default, is_public, tags)
VALUES (
    '10000000-0000-0000-0000-000000000001'::UUID,
    NULL,
    '标准训练剧本配置模板',
    '将教师任务文档转化为包含阶段划分、提示词、状态机逻辑的完整训练剧本配置。支持顺序检查型和累积检查型两种任务类型。',
    'script',
    '你是一名专业的**实训剧本架构师**（Training Script Architect）。你的任务是将下方的【教师输入文档】转化为完整的训练剧本配置。

# 核心要求

**重要：你必须根据实际文档内容生成真实的配置，不要输出示例、占位符或省略号！**

1. 仔细分析文档，提取任务名称、目标、智能体角色、任务流程、对话示例等信息
2. 将任务拆解为3-5个阶段，每个阶段包含完整的提示词（含具体的判定条件和话术）
3. 识别任务类型（顺序检查型 or 累积检查型），编写对应的 Workflow 逻辑
4. 为每个阶段生成符合人设的开场白（如文档中有，直接使用）
5. 直接输出完整的 Markdown 配置，用 ```markdown 代码块包裹

# 输出格式

```markdown
# [从文档提取的任务名称] - 训练剧本配置

## 📋 基础配置
- **任务名称**: [从文档提取]
- **任务描述**: [从文档提取训练目的]
- **智能体角色**: [从文档提取角色名、身份、性格]
- **目标受众**: [从文档提取适用学生群体]

## 📝 训练阶段

### 阶段1: [根据文档设计的阶段名称]

**虚拟训练官名字**: [从提示词Role部分提取角色名]
**模型**: (选填，默认为空)
**声音**: (选填，默认为空)
**形象**: (选填，默认为空)
**阶段描述**: [说明本阶段教学目的]
**背景图**: (选填，默认为空)
**互动轮次**: [根据复杂度设定，如3轮]
**flowCondition**: "NEXT_TO_STAGE2"
**transitionPrompt**:
```
【输入参数】
    - 下一阶段原始开场白 ${ next_stage_opening }
【整体生成目标】
    基于下一阶段的原始开场白，生成符合当前教学场景的自然过渡话语。可以：
    1. 直接使用下一阶段原始开场白
    2. 或根据当前对话上下文调整开场白的表述方式，使过渡更自然
```

**开场白**:
> [根据文档和角色设定生成的第一句话]

**提示词**:
```markdown
# Role
[详细描述角色人设、性格、背景]

# Context & Task
[说明当前阶段的教学任务和考核重点]

# Opening Line(你已经在上一轮输出过这句话，请基于此进行回复)
[复述上面的开场白内容]

# Workflow & Interaction Rules
[根据任务类型选择对应结构]

# Response Constraints
- 语气：[符合角色性格]
- 跳转纯净性：满足跳转条件时，仅输出跳转关键词，不含标点或其他字符
- 单次回复字数：[根据场景设定，如50-100字]
```

## 🔄 阶段跳转关系
- 阶段1 → 阶段2：条件为 [具体描述]，跳转关键词 NEXT_TO_STAGE2
- 最后阶段 → 结束：输出 TASK_COMPLETE

## 📖 配置说明
[简要说明设计思路、关键考核点、反剧透设计等]
```

# 关键约束

1. **不要输出占位符！** 所有内容必须基于文档生成真实具体的内容
2. **不要输出示例性描述！** 如"[阶段名称]"、"[描述xxx]"、"..."等必须替换为实际内容
3. **必须有具体的Workflow逻辑！** 包含明确的判定条件、回复策略和话术示例
4. **反剧透设计！** 话术示例要引导而非告知答案
5. **直接输出配置！** 不要输出前言、分析或解释，直接输出 Markdown 代码块

---

以下是【教师输入文档】：

<teacher_document>
{teacherDoc}
</teacher_document>

请开始生成完整的训练剧本配置。记住：不要输出占位符，必须生成真实具体的内容！',
    '你是一名专业的实训剧本架构师（Training Script Architect），擅长将非标准化实训任务文档转化为结构清晰、逻辑严密的 Markdown 格式训练剧本配置。
你的输出必须是完整的 Markdown 文档，包含基础配置、训练阶段、提示词、跳转逻辑等。
不要输出 JSON，不要做评分，不要输出与剧本配置无关的内容。',
    TRUE,
    TRUE,
    ARRAY['通用', '实训', '剧本']
) ON CONFLICT (id) DO UPDATE SET
    prompt_template = EXCLUDED.prompt_template,
    system_prompt = EXCLUDED.system_prompt,
    updated_at = NOW();

-- 8. 插入系统默认模板 - 评分标准
INSERT INTO prompt_templates (id, user_id, name, description, type, prompt_template, system_prompt, is_default, is_public, tags)
VALUES (
    '10000000-0000-0000-0000-000000000002'::UUID,
    NULL,
    '标准评分标准模板',
    '根据教师任务文档生成包含主评分项和分数区间描述的评价标准，总分100分，3-5个主评分项。',
    'rubric',
    '你是一个专业的【训练评价标准生成器】。你的任务是根据下方的【教师输入文档】，生成**主评分项+评分区间描述**的评价标准。

# 核心要求

**重要：你必须根据实际文档内容生成真实的评价标准，不要输出示例、占位符或省略号！**

1. 仔细分析文档，提取任务目标、考核要点
2. 根据任务目标自动生成 3–5 个主评分项，总分 100 分
3. 不设子评分点，只保留主评分项
4. 对每个主评分项，直接给出：评分项名称、该项总分值、50-100字的核心能力描述、不同分数区间的表现描述
5. 直接输出完整的 Markdown 评价标准，用 ```markdown 代码块包裹

# 输出格式

```markdown
# [从文档提取的任务名称] - 评价标准

## 总分：100 分

## 评价标准概述
[100–150 字，基于文档说明整体考核思路与重点]

---

## 一、[主评分项1名称]（[分值] 分）
[50-100字，说明本主评分项考查的核心能力]
- **90–100 分**：[该区间详细表现描述]
- **80–89 分**：[该区间详细表现描述]
- **70–79 分**：[该区间详细表现描述]
- **60–69 分**：[该区间详细表现描述]
- **60 分以下**：[该区间详细表现描述]

---

## 评分说明
- 总分 100 分，各主评分项独立评分
- 按对应分数区间描述直接判定该项得分，不拆分子要点
- 未达到基本要求的，按 60 分以下标准评分
```

# 关键约束

1. **不要输出占位符！** 必须替换为实际内容
2. **只保留主评分项，不设子得分点**
3. **分值必须合理！** 总分100分，各主评分项分值分配均衡
4. **评价要求要详细！** 核心能力描述需50-100字且具体
5. **直接输出配置！** 不要输出前言、分析或解释，直接输出 Markdown 代码块

---

以下是【教师输入文档】：

<teacher_document>
{teacherDoc}
</teacher_document>

请开始生成完整的评价标准。记住：不要输出占位符，必须生成真实具体的内容！',
    '你是一个专业的训练评价标准生成器。你的任务是根据实训任务文档，生成层级化的评价标准。
采用"主评分项-评分区间描述"结构，以 Markdown 格式输出。
不要输出 JSON，不要做对话评分，不要输出与评价标准无关的内容。',
    TRUE,
    TRUE,
    ARRAY['通用', '评分', '标准']
) ON CONFLICT (id) DO UPDATE SET
    prompt_template = EXCLUDED.prompt_template,
    system_prompt = EXCLUDED.system_prompt,
    updated_at = NOW();
