import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { nanoid } from 'nanoid';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// GET: 获取单个评测详情
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        // 先尝试通过 id 获取
        let { data, error } = await supabase
            .from('evaluations')
            .select('*')
            .eq('id', id)
            .single();

        // 如果没找到，尝试通过 share_token 获取
        if (error || !data) {
            const result = await supabase
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

        // 如果不是公开的且没有分享 token，检查是否是所有者
        if (!data.is_public && !data.share_token) {
            const authHeader = request.headers.get('authorization');
            if (!authHeader) {
                return NextResponse.json({ error: '无权访问' }, { status: 403 });
            }

            const token = authHeader.replace('Bearer ', '');
            const { data: { user } } = await supabase.auth.getUser(token);

            if (!user || user.id !== data.user_id) {
                return NextResponse.json({ error: '无权访问' }, { status: 403 });
            }
        }

        return NextResponse.json({ evaluation: data });

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
        const { is_public } = body;

        // 只能更新自己的评测
        const { data, error } = await supabase
            .from('evaluations')
            .update({ is_public })
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
