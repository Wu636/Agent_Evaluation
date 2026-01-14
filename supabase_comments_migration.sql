-- 评论系统数据库迁移脚本
-- 执行位置：Supabase Dashboard > SQL Editor

-- 1. 创建评论表
CREATE TABLE IF NOT EXISTS evaluation_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evaluation_id UUID NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    user_name TEXT NOT NULL,
    user_email TEXT,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_edited BOOLEAN DEFAULT FALSE,
    parent_comment_id UUID REFERENCES evaluation_comments(id) ON DELETE CASCADE
);

-- 2. 创建索引
CREATE INDEX IF NOT EXISTS idx_comments_evaluation ON evaluation_comments(evaluation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_user ON evaluation_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON evaluation_comments(parent_comment_id);

-- 3. 启用 RLS
ALTER TABLE evaluation_comments ENABLE ROW LEVEL SECURITY;

-- 4. RLS 策略：任何人都可以查看公开报告的评论
CREATE POLICY "Anyone can view comments on public evaluations"
ON evaluation_comments FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM evaluations
        WHERE evaluations.id = evaluation_comments.evaluation_id
        AND evaluations.is_public = true
    )
);

-- 5. RLS 策略：登录用户可以查看自己报告的评论
CREATE POLICY "Users can view comments on their own evaluations"
ON evaluation_comments FOR SELECT
USING (
    auth.uid() IN (
        SELECT user_id FROM evaluations
        WHERE evaluations.id = evaluation_comments.evaluation_id
    )
);

-- 6. RLS 策略：登录用户可以在公开报告或自己的报告上发表评论
CREATE POLICY "Authenticated users can create comments"
ON evaluation_comments FOR INSERT
WITH CHECK (
    auth.uid() IS NOT NULL
    AND (
        EXISTS (
            SELECT 1 FROM evaluations
            WHERE evaluations.id = evaluation_comments.evaluation_id
            AND (evaluations.is_public = true OR evaluations.user_id = auth.uid())
        )
    )
);

-- 7. RLS 策略：用户可以编辑自己的评论
CREATE POLICY "Users can update their own comments"
ON evaluation_comments FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- 8. RLS 策略：用户可以删除自己的评论
CREATE POLICY "Users can delete their own comments"
ON evaluation_comments FOR DELETE
USING (auth.uid() = user_id);

-- 9. 创建更新时间触发器函数
CREATE OR REPLACE FUNCTION update_comment_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    NEW.is_edited = TRUE;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 10. 创建触发器
DROP TRIGGER IF EXISTS set_comment_updated_at ON evaluation_comments;
CREATE TRIGGER set_comment_updated_at
    BEFORE UPDATE ON evaluation_comments
    FOR EACH ROW
    EXECUTE FUNCTION update_comment_updated_at();
