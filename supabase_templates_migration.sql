-- 自定义评测模板系统迁移脚本
-- 执行位置：Supabase Dashboard > SQL Editor
-- Phase 7: Custom Evaluation Templates

-- 1. 创建评测模板表
CREATE TABLE IF NOT EXISTS evaluation_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    is_default BOOLEAN DEFAULT FALSE,
    is_public BOOLEAN DEFAULT FALSE,
    dimensions JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 创建索引
CREATE INDEX IF NOT EXISTS idx_templates_user_id ON evaluation_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_is_public ON evaluation_templates(is_public);
CREATE INDEX IF NOT EXISTS idx_templates_is_default ON evaluation_templates(is_default);

-- 3. 启用 RLS
ALTER TABLE evaluation_templates ENABLE ROW LEVEL SECURITY;

-- 4. RLS 策略

-- 用户可以查看自己的模板
CREATE POLICY "Users can view own templates"
ON evaluation_templates FOR SELECT
USING (auth.uid() = user_id);

-- 用户可以查看公开模板
CREATE POLICY "Public templates are viewable by all"
ON evaluation_templates FOR SELECT
USING (is_public = TRUE);

-- 用户可以查看系统默认模板 (user_id = NULL)
CREATE POLICY "Default templates are viewable by all"
ON evaluation_templates FOR SELECT
USING (user_id IS NULL AND is_default = TRUE);

-- 用户可以创建自己的模板
CREATE POLICY "Users can create own templates"
ON evaluation_templates FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- 用户可以更新自己的模板
CREATE POLICY "Users can update own templates"
ON evaluation_templates FOR UPDATE
USING (auth.uid() = user_id);

-- 用户可以删除自己的模板
CREATE POLICY "Users can delete own templates"
ON evaluation_templates FOR DELETE
USING (auth.uid() = user_id);

-- 5. 更新时间戳触发器
CREATE OR REPLACE FUNCTION update_template_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_template_timestamp ON evaluation_templates;
CREATE TRIGGER trigger_update_template_timestamp
    BEFORE UPDATE ON evaluation_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_template_timestamp();

-- 6. 插入系统默认模板 (完整 21 维度)
INSERT INTO evaluation_templates (id, user_id, name, description, is_default, is_public, dimensions)
VALUES (
    '00000000-0000-0000-0000-000000000001'::UUID,
    NULL,  -- 系统模板无所有者
    '标准评测模板',
    '包含全部 5 个主维度、21 个子维度的完整评测体系',
    TRUE,
    TRUE,
    '{
        "goal_completion": {
            "enabled": true,
            "weight": 1.0,
            "subDimensions": {
                "knowledge_coverage": { "enabled": true, "fullScore": 10 },
                "ability_coverage": { "enabled": true, "fullScore": 10 }
            }
        },
        "workflow_adherence": {
            "enabled": true,
            "weight": 1.0,
            "subDimensions": {
                "entry_criteria": { "enabled": true, "fullScore": 4 },
                "internal_sequence": { "enabled": true, "fullScore": 4 },
                "global_stage_flow": { "enabled": true, "fullScore": 4 },
                "exit_criteria": { "enabled": true, "fullScore": 4 },
                "nonlinear_navigation": { "enabled": true, "fullScore": 4 }
            }
        },
        "interaction_experience": {
            "enabled": true,
            "weight": 1.0,
            "subDimensions": {
                "persona_stylization": { "enabled": true, "fullScore": 4 },
                "naturalness": { "enabled": true, "fullScore": 4 },
                "contextual_coherence": { "enabled": true, "fullScore": 4 },
                "loop_stasis": { "enabled": true, "fullScore": 4 },
                "conciseness": { "enabled": true, "fullScore": 4 }
            }
        },
        "accuracy_boundaries": {
            "enabled": true,
            "weight": 1.0,
            "subDimensions": {
                "factuality": { "enabled": true, "fullScore": 4 },
                "logical_consistency": { "enabled": true, "fullScore": 4 },
                "admittance_ignorance": { "enabled": true, "fullScore": 4 },
                "safety_guardrails": { "enabled": true, "fullScore": 4 },
                "distraction_resistance": { "enabled": true, "fullScore": 4 }
            }
        },
        "teaching_strategy": {
            "enabled": true,
            "weight": 1.0,
            "subDimensions": {
                "socratic_frequency": { "enabled": true, "fullScore": 5 },
                "positive_reinforcement": { "enabled": true, "fullScore": 5 },
                "correction_pathway": { "enabled": true, "fullScore": 5 },
                "deep_probing": { "enabled": true, "fullScore": 5 }
            }
        }
    }'::JSONB
) ON CONFLICT (id) DO UPDATE SET
    dimensions = EXCLUDED.dimensions,
    updated_at = NOW();

-- 7. 辅助 RPC: 获取默认模板
CREATE OR REPLACE FUNCTION get_default_template()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN (
        SELECT to_jsonb(t)
        FROM evaluation_templates t
        WHERE is_default = TRUE AND user_id IS NULL
        LIMIT 1
    );
END;
$$;

-- 8. 辅助 RPC: 获取用户的模板列表
CREATE OR REPLACE FUNCTION get_user_templates()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN COALESCE(
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC)
         FROM evaluation_templates t
         WHERE t.user_id = auth.uid() OR (t.is_default = TRUE AND t.user_id IS NULL)),
        '[]'::JSONB
    );
END;
$$;
