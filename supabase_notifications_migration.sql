-- 消息通知系统数据库迁移脚本
-- 执行位置：Supabase Dashboard > SQL Editor

-- 1. 创建通知表
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- 接收通知的人
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- 触发通知的人
    actor_name TEXT, -- 触发者名字快照
    type TEXT NOT NULL CHECK (type IN ('comment', 'reply', 'mention')),
    resource_id UUID NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE, -- 关联的评测报告
    resource_type TEXT DEFAULT 'evaluation',
    meta_data JSONB, -- 存储额外信息，如 comment_id, snippet
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 索引
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- 3. RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own notifications"
ON notifications FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own notifications"
ON notifications FOR UPDATE
USING (auth.uid() = user_id);

-- 4. 更新 post_comment RPC 以包含通知逻辑 (支持 @提及)
CREATE OR REPLACE FUNCTION post_comment(
    p_evaluation_id UUID,
    p_content TEXT,
    p_parent_comment_id UUID DEFAULT NULL,
    p_mentioned_user_ids UUID[] DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_user_email TEXT;
    v_user_name TEXT;
    v_evaluation_public BOOLEAN;
    v_evaluation_owner UUID;
    v_evaluation_title TEXT;
    v_new_comment RECORD;
    v_parent_comment_author UUID;
    v_notification_recipient UUID;
    v_mentioned_user_id UUID;
    v_notified_users UUID[] := '{}'; -- Keep track of who we notified to avoid duplicates
BEGIN
    -- 1. Get current user
    v_user_id := auth.uid();
    v_user_email := auth.jwt() ->> 'email';
    
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- 2. Get user profile
    SELECT name INTO v_user_name
    FROM profiles
    WHERE id = v_user_id;
    
    IF v_user_name IS NULL THEN
        v_user_name := COALESCE(split_part(v_user_email, '@', 1), '匿名用户');
    END IF;

    -- 3. Check evaluation and get details
    SELECT is_public, user_id, teacher_doc_name INTO v_evaluation_public, v_evaluation_owner, v_evaluation_title
    FROM evaluations
    WHERE id = p_evaluation_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Evaluation not found';
    END IF;
    
    IF NOT v_evaluation_public AND v_evaluation_owner != v_user_id THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    -- 4. Insert comment
    INSERT INTO evaluation_comments (
        evaluation_id,
        user_id,
        user_name,
        user_email,
        content,
        parent_comment_id
    )
    VALUES (
        p_evaluation_id,
        v_user_id,
        v_user_name,
        v_user_email,
        p_content,
        p_parent_comment_id
    )
    RETURNING * INTO v_new_comment;

    -- 5. Notification Logic
    
    -- 5.1 Handle Mentions
    IF p_mentioned_user_ids IS NOT NULL THEN
        FOREACH v_mentioned_user_id IN ARRAY p_mentioned_user_ids
        LOOP
            IF v_mentioned_user_id != v_user_id AND NOT (v_mentioned_user_id = ANY(v_notified_users)) THEN
                INSERT INTO notifications (
                    user_id, actor_id, actor_name, type, resource_id, meta_data
                ) VALUES (
                    v_mentioned_user_id,
                    v_user_id,
                    v_user_name,
                    'mention',
                    p_evaluation_id,
                    jsonb_build_object(
                        'comment_id', v_new_comment.id,
                        'snippet', substring(p_content from 1 for 50),
                        'evaluation_title', v_evaluation_title
                    )
                );
                v_notified_users := array_append(v_notified_users, v_mentioned_user_id);
            END IF;
        END LOOP;
    END IF;

    -- 5.2 Handle Reply or Owner Notification
    v_notification_recipient := NULL;

    IF p_parent_comment_id IS NOT NULL THEN
        -- Case A: Reply to a comment -> Notify parent comment author
        SELECT user_id INTO v_parent_comment_author
        FROM evaluation_comments
        WHERE id = p_parent_comment_id;

        -- Notify only if not self, AND not already notified via mention
        IF v_parent_comment_author IS NOT NULL 
           AND v_parent_comment_author != v_user_id 
           AND NOT (v_parent_comment_author = ANY(v_notified_users)) 
        THEN
            v_notification_recipient := v_parent_comment_author;
            
            INSERT INTO notifications (
                user_id, actor_id, actor_name, type, resource_id, meta_data
            ) VALUES (
                v_notification_recipient,
                v_user_id,
                v_user_name,
                'reply',
                p_evaluation_id,
                jsonb_build_object(
                    'comment_id', v_new_comment.id,
                    'parent_comment_id', p_parent_comment_id,
                    'snippet', substring(p_content from 1 for 50),
                    'evaluation_title', v_evaluation_title
                )
            );
        END IF;
    ELSE
        -- Case B: Direct comment on report -> Notify report owner
        -- Notify only if not self, AND not already notified via mention
        IF v_evaluation_owner != v_user_id 
           AND NOT (v_evaluation_owner = ANY(v_notified_users)) 
        THEN
            v_notification_recipient := v_evaluation_owner;
            
            INSERT INTO notifications (
                user_id, actor_id, actor_name, type, resource_id, meta_data
            ) VALUES (
                v_notification_recipient,
                v_user_id,
                v_user_name,
                'comment',
                p_evaluation_id,
                jsonb_build_object(
                    'comment_id', v_new_comment.id,
                    'snippet', substring(p_content from 1 for 50),
                    'evaluation_title', v_evaluation_title
                )
            );
        END IF;
    END IF;

    -- 6. Return the new comment
    RETURN to_jsonb(v_new_comment);
END;
$$;

-- 5. 辅助 RPC: 获取未读数量
CREATE OR REPLACE FUNCTION get_unread_notifications_count()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN (
        SELECT COUNT(*)
        FROM notifications
        WHERE user_id = auth.uid()
        AND is_read = FALSE
    );
END;
$$;

-- 6. 辅助 RPC: 标记所有已读
CREATE OR REPLACE FUNCTION mark_all_notifications_read()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE notifications
    SET is_read = TRUE
    WHERE user_id = auth.uid()
    AND is_read = FALSE;
END;
$$;

-- 7. 辅助 RPC: 标记单个已读
CREATE OR REPLACE FUNCTION mark_notification_read(p_notification_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE notifications
    SET is_read = TRUE
    WHERE id = p_notification_id
    AND user_id = auth.uid();
END;
$$;

-- 8. 辅助 RPC: 搜索用户 (用于 @提及)
DROP FUNCTION IF EXISTS search_users(TEXT);

CREATE OR REPLACE FUNCTION search_users(p_query TEXT)
RETURNS TABLE (
    id UUID,
    name TEXT,
    avatar_url TEXT,
    email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT profiles.id, profiles.name, profiles.avatar_url, profiles.email
    FROM profiles
    WHERE profiles.name ILIKE '%' || p_query || '%'
       OR profiles.email ILIKE '%' || p_query || '%'
    LIMIT 10;
END;
$$;
