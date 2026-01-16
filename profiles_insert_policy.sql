-- 为 profiles 表添加 INSERT 策略
-- 在 Supabase Dashboard > SQL Editor 中执行

-- 先删除策略（如果存在）
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;

-- 允许用户创建自己的 profile（如果触发器未自动创建）
CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = id);
