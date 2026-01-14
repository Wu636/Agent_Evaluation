-- Supabase 数据库表创建脚本
-- 请在 Supabase Dashboard > SQL Editor 中执行

-- 1. 创建 profiles 表（扩展用户信息）
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 创建 evaluations 表
CREATE TABLE IF NOT EXISTS evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  
  -- 文档内容
  teacher_doc_name TEXT,
  teacher_doc_content TEXT,
  dialogue_record_name TEXT,
  dialogue_data JSONB,
  
  -- 评测结果
  total_score NUMERIC(5,2),
  final_level TEXT,
  veto_reasons JSONB DEFAULT '[]',
  model_used TEXT,
  dimensions JSONB,
  
  -- 分享设置
  is_public BOOLEAN DEFAULT FALSE,
  share_token TEXT UNIQUE,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. 创建索引
CREATE INDEX IF NOT EXISTS idx_evaluations_user_id ON evaluations(user_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_is_public ON evaluations(is_public);
CREATE INDEX IF NOT EXISTS idx_evaluations_share_token ON evaluations(share_token);
CREATE INDEX IF NOT EXISTS idx_evaluations_created_at ON evaluations(created_at DESC);

-- 4. 启用 RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluations ENABLE ROW LEVEL SECURITY;

-- 5. profiles 表的 RLS 策略
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

-- 6. evaluations 表的 RLS 策略
-- 用户可以查看自己的评测
CREATE POLICY "Users can view own evaluations"
  ON evaluations FOR SELECT
  USING (auth.uid() = user_id);

-- 公开的评测任何人可查看
CREATE POLICY "Public evaluations are viewable by all"
  ON evaluations FOR SELECT
  USING (is_public = TRUE);

-- 通过分享链接可查看（匿名用户）
CREATE POLICY "Shared evaluations viewable with token"
  ON evaluations FOR SELECT
  USING (share_token IS NOT NULL);

-- 用户可以创建自己的评测
CREATE POLICY "Users can insert own evaluations"
  ON evaluations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户可以更新自己的评测
CREATE POLICY "Users can update own evaluations"
  ON evaluations FOR UPDATE
  USING (auth.uid() = user_id);

-- 用户可以删除自己的评测
CREATE POLICY "Users can delete own evaluations"
  ON evaluations FOR DELETE
  USING (auth.uid() = user_id);

-- 7. 自动创建 profile 的触发器
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.raw_user_meta_data->>'full_name'),
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
