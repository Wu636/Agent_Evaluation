-- 创建 saved_reports 表
CREATE TABLE IF NOT EXISTS saved_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  evaluation_id UUID REFERENCES evaluations(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, evaluation_id)
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_saved_reports_user_id ON saved_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_reports_created_at ON saved_reports(created_at DESC);

-- 启用 RLS
ALTER TABLE saved_reports ENABLE ROW LEVEL SECURITY;

-- RLS 策略

-- 用户可以查看自己的收藏
CREATE POLICY "Users can view own saved reports"
  ON saved_reports FOR SELECT
  USING (auth.uid() = user_id);

-- 用户可以添加收藏
CREATE POLICY "Users can insert own saved reports"
  ON saved_reports FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用户可以删除自己的收藏
CREATE POLICY "Users can delete own saved reports"
  ON saved_reports FOR DELETE
  USING (auth.uid() = user_id);
