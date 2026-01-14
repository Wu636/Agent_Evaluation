import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { nanoid } from 'nanoid';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// POST: 生成分享链接
export async function POST(
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

        // 生成唯一的分享 token
        const shareToken = nanoid(12);

        // 更新评测记录
        const { data, error } = await supabase
            .from('evaluations')
            .update({ share_token: shareToken })
            .eq('id', id)
            .eq('user_id', user.id)
            .select()
            .single();

        if (error) throw error;

        const shareUrl = `${request.nextUrl.origin}/report/${shareToken}`;

        return NextResponse.json({
            share_token: shareToken,
            share_url: shareUrl
        });

    } catch (error) {
        console.error('生成分享链接失败:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '生成失败' },
            { status: 500 }
        );
    }
}

// DELETE: 取消分享
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

        // 清除分享 token
        const { error } = await supabase
            .from('evaluations')
            .update({ share_token: null })
            .eq('id', id)
            .eq('user_id', user.id);

        if (error) throw error;

        return NextResponse.json({ success: true });

    } catch (error) {
        console.error('取消分享失败:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '取消失败' },
            { status: 500 }
        );
    }
}
