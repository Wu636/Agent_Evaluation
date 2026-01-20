import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

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
                        // The `setAll` method was called from a Server Component.
                        // This can be ignored if you have middleware refreshing
                        // user sessions.
                    }
                },
            },
        }
    );
}

// 获取用户的收藏列表
export async function GET(request: Request) {
    const supabase = await createSupabaseClient();

    // 验证用户是否登录
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // 获取收藏的评测，同时关联查询评测详情
        const { data, error } = await supabase
            .from('saved_reports')
            .select(`
                created_at,
                evaluation:evaluations (
                    id,
                    teacher_doc_name,
                    dialogue_record_name,
                    total_score,
                    final_level,
                    model_used,
                    created_at,
                    is_public,
                    dimensions
                )
            `)
            .eq('user_id', session.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // 扁平化结构，方便前端使用
        const savedReports = data.map((item: any) => ({
            ...item.evaluation,
            saved_at: item.created_at
        }));

        return NextResponse.json({ savedReports });
    } catch (error: any) {
        console.error('Error fetching saved reports:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// 添加收藏
export async function POST(request: Request) {
    const supabase = await createSupabaseClient();

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { evaluationId } = await request.json();
        if (!evaluationId) {
            return NextResponse.json({ error: 'Evaluation ID is required' }, { status: 400 });
        }

        const { error } = await supabase
            .from('saved_reports')
            .insert({
                user_id: session.user.id,
                evaluation_id: evaluationId
            });

        if (error) {
            // 忽略重复键错误 (即已经收藏过)
            if (error.code === '23505') { // Postgres unique_violation code
                return NextResponse.json({ message: 'Already saved' });
            }
            throw error;
        }

        return NextResponse.json({ message: 'Saved successfully' });
    } catch (error: any) {
        console.error('Error saving report:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// 取消收藏
export async function DELETE(request: Request) {
    const supabase = await createSupabaseClient();

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { searchParams } = new URL(request.url);
        const evaluationId = searchParams.get('id');

        if (!evaluationId) {
            return NextResponse.json({ error: 'Evaluation ID is required' }, { status: 400 });
        }

        const { error } = await supabase
            .from('saved_reports')
            .delete()
            .eq('user_id', session.user.id)
            .eq('evaluation_id', evaluationId);

        if (error) throw error;

        return NextResponse.json({ message: 'Unsaved successfully' });
    } catch (error: any) {
        console.error('Error unsaving report:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
