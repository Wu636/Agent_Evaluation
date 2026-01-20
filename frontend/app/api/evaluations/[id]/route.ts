import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

async function createSupabaseSSRClient() {
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

// GET: 获取单个评测详情
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;

        // 1. 使用 Service Key 获取数据 (绕过 RLS 以获取初始数据)
        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // 先尝试通过 id 获取
        let { data, error } = await adminSupabase
            .from('evaluations')
            .select('*')
            .eq('id', id)
            .single();

        // 如果没找到，尝试通过 share_token 获取
        if (error || !data) {
            const result = await adminSupabase
                .from('evaluations')
                .select('*')
                .eq('share_token', id)
                .single();

            data = result.data;
            error = result.error;
        }

        if (error || !data) {
            return NextResponse.json({ error: '评测不存在' }, { status: 404 });
        }

        // 2. 权限检查
        // 如果不是公开的且没有分享 token，检查是否是所有者
        if (!data.is_public && !data.share_token) {
            const supabase = await createSupabaseSSRClient();
            const { data: { user } } = await supabase.auth.getUser();

            if (!user || user.id !== data.user_id) {
                return NextResponse.json({ error: '无权访问' }, { status: 403 });
            }
        }

        // 3. 检查是否已收藏
        let is_saved = false;
        const supabase = await createSupabaseSSRClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (user) {
            const { count } = await supabase
                .from('saved_reports')
                .select('*', { count: 'exact', head: true })
                .eq('user_id', user.id)
                .eq('evaluation_id', data.id);

            is_saved = !!count;
        }

        return NextResponse.json({ evaluation: { ...data, is_saved } });

    } catch (error) {
        console.error('获取评测详情失败:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '获取失败' },
            { status: 500 }
        );
    }
}

// PATCH: 更新评测（如修改公开状态）
export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        const authHeader = request.headers.get('authorization');
        if (!authHeader) {
            return NextResponse.json({ error: '未登录' }, { status: 401 });
        }

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
            return NextResponse.json({ error: '认证失败' }, { status: 401 });
        }

        const body = await request.json();
        const { is_public, teacher_doc_name } = body;

        const updates: any = {};
        if (typeof is_public !== 'undefined') updates.is_public = is_public;
        if (typeof teacher_doc_name !== 'undefined') updates.teacher_doc_name = teacher_doc_name;

        if (Object.keys(updates).length === 0) {
            return NextResponse.json({ error: '没有提供更新内容' }, { status: 400 });
        }

        // 只能更新自己的评测
        const { data, error } = await supabase
            .from('evaluations')
            .update(updates)
            .eq('id', id)
            .eq('user_id', user.id)
            .select()
            .single();

        if (error) throw error;

        return NextResponse.json({ evaluation: data });

    } catch (error) {
        console.error('更新评测失败:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '更新失败' },
            { status: 500 }
        );
    }
}

// DELETE: 删除评测
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        const authHeader = request.headers.get('authorization');
        if (!authHeader) {
            return NextResponse.json({ error: '未登录' }, { status: 401 });
        }

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
            return NextResponse.json({ error: '认证失败' }, { status: 401 });
        }

        // 只能删除自己的评测
        const { error } = await supabase
            .from('evaluations')
            .delete()
            .eq('id', id)
            .eq('user_id', user.id);

        if (error) throw error;

        return NextResponse.json({ success: true });

    } catch (error) {
        console.error('删除评测失败:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '删除失败' },
            { status: 500 }
        );
    }
}
