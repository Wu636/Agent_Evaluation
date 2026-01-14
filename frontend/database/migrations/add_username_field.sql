-- 添加用户名字段到 profiles 表
ALTER TABLE profiles ADD COLUMN username TEXT NULL;

-- 创建唯一索引确保用户名唯一
CREATE UNIQUE INDEX profiles_username_key ON profiles(username) WHERE username IS NOT NULL;

-- 创建函数用于用户名登录时的邮箱查找
CREATE OR REPLACE FUNCTION get_email_by_username(input_username TEXT)
RETURNS TABLE(email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT p.email 
    FROM profiles p 
    WHERE p.username = input_username;
END;
$$;