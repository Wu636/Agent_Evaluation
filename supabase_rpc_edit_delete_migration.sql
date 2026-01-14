-- Function to edit a comment
CREATE OR REPLACE FUNCTION edit_comment(
    p_comment_id UUID,
    p_content TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_comment_user_id UUID;
    v_updated_comment RECORD;
BEGIN
    -- 1. Get current user
    v_user_id := auth.uid();
    
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- 2. Check comment existence and ownership
    SELECT user_id INTO v_comment_user_id
    FROM evaluation_comments
    WHERE id = p_comment_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Comment not found';
    END IF;
    
    IF v_comment_user_id != v_user_id THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    -- 3. Update comment
    UPDATE evaluation_comments
    SET content = p_content
    WHERE id = p_comment_id
    RETURNING * INTO v_updated_comment;

    RETURN to_jsonb(v_updated_comment);
END;
$$;

-- Function to delete a comment
CREATE OR REPLACE FUNCTION delete_comment(
    p_comment_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id UUID;
    v_comment_user_id UUID;
BEGIN
    -- 1. Get current user
    v_user_id := auth.uid();
    
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- 2. Check comment existence and ownership
    SELECT user_id INTO v_comment_user_id
    FROM evaluation_comments
    WHERE id = p_comment_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Comment not found';
    END IF;
    
    IF v_comment_user_id != v_user_id THEN
        RAISE EXCEPTION 'Permission denied';
    END IF;

    -- 3. Delete comment
    DELETE FROM evaluation_comments
    WHERE id = p_comment_id;

    RETURN TRUE;
END;
$$;
