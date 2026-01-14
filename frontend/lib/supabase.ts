import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Only create client if both URL and key are provided
export const supabase = supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

// Helper to check if Supabase is configured
export const isSupabaseConfigured = () => !!supabase;

// 数据库类型定义
export interface Profile {
    id: string;
    email: string | null;
    name: string | null;
    username: string | null;
    avatar_url: string | null;
    created_at: string;
}

export interface Evaluation {
    id: string;
    user_id: string;
    teacher_doc_name: string;
    teacher_doc_content: string;
    dialogue_record_name: string;
    dialogue_data: any;
    total_score: number;
    final_level: string;
    veto_reasons: string[];
    model_used: string;
    dimensions: any[];
    is_public: boolean;
    share_token: string | null;
    created_at: string;
}
