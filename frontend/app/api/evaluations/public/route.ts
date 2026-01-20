import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

async function createSupabaseClient() {
    const cookieStore = await cookies();
    return createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll()
                },
                setAll(cookiesToSet) {
                    try {
                        cookiesToSet.forEach(({ name, value, options }) =>
                            cookieStore.set(name, value, options)
                        )
                    } catch {
                    }
                },
            },
        }
    );
}

// GET: 获取公开的评测列表
export async function GET(request: NextRequest) {
    try {
        const supabase = await createSupabaseClient();

        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '50');
        const offset = parseInt(searchParams.get('offset') || '0');

        // 获取公开的评测
        // 使用 anon key 客户端，依赖 RLS "Public evaluations are viewable by all"
        const { data, error } = await supabase
            .from('evaluations')
            .select('id, teacher_doc_name, dialogue_record_name, total_score, final_level, model_used, created_at, share_token')
            .eq('is_public', true)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) throw error;

        let evaluations = data || [];

        // 如果用户已登录，检查收藏状态
        const { data: { session } } = await supabase.auth.getSession();
        if (session && evaluations.length > 0) {
            const ids = evaluations.map((e: any) => e.id);
            const { data: savedData } = await supabase
                .from('saved_reports')
                .select('evaluation_id')
                .eq('user_id', session.user.id)
                .in('evaluation_id', ids);

            const savedSet = new Set(savedData?.map((s: any) => s.evaluation_id));
            evaluations = evaluations.map((e: any) => ({
                ...e,
                is_saved: savedSet.has(e.id)
            }));
        } else {
            evaluations = evaluations.map((e: any) => ({
                ...e,
                is_saved: false
            }));
        }

        return NextResponse.json({ evaluations });

    } catch (error) {
        console.error('获取公开评测失败:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '获取失败' },
            { status: 500 }
        );
    }
}
