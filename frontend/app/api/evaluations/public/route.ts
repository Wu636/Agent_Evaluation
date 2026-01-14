import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// GET: 获取公开的评测列表
export async function GET(request: NextRequest) {
    try {
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '50');
        const offset = parseInt(searchParams.get('offset') || '0');

        // 获取公开的评测
        const { data, error } = await supabase
            .from('evaluations')
            .select('id, teacher_doc_name, dialogue_record_name, total_score, final_level, model_used, created_at, share_token')
            .eq('is_public', true)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        return NextResponse.json({ evaluations: data || [] });

    } catch (error) {
        console.error('获取公开评测失败:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '获取失败' },
            { status: 500 }
        );
    }
}
