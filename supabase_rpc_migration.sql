-- Create a function to handle comment posting in a single transaction
-- This reduces network roundtrips from 3-4 to 1

CREATE OR REPLACE FUNCTION post_comment(
    p_evaluation_id UUID,
    p_content TEXT,
    p_parent_comment_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER -- Run as owner to bypass RLS for checks, but we strictly check auth.uid()
AS $$
DECLARE
    v_user_id UUID;
    v_user_email TEXT;
    v_user_name TEXT;
    v_evaluation_public BOOLEAN;
    v_evaluation_owner UUID;
    v_new_comment RECORD;
BEGIN
    -- 1. Get current user
    v_user_id := auth.uid();
    v_user_email := auth.jwt() ->> 'email';
    
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- 2. Get user profile name (fallback to email prefix)
    SELECT name INTO v_user_name
    FROM profiles
    WHERE id = v_user_id;
    
    IF v_user_name IS NULL THEN
        v_user_name := COALESCE(split_part(v_user_email, '@', 1), '匿名用户');
    END IF;

    -- 3. Check evaluation existence and permissions
    SELECT is_public, user_id INTO v_evaluation_public, v_evaluation_owner
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

    -- 5. Return the new comment as JSON
    RETURN to_jsonb(v_new_comment);
END;
$$;
