import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function PATCH(
    request: NextRequest,
    props: { params: Promise<{ commentId: string }> }
) {
    const params = await props.params;
    try {
        const commentId = params.commentId;
        const authHeader = request.headers.get('Authorization');

        if (!authHeader) {
            return NextResponse.json({ error: '未授权' }, { status: 401 });
        }

        // 使用 Anon Key + 用户 Token 创建客户端
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: {
                    headers: {
                        Authorization: authHeader,
                    },
                },
                auth: {
                    persistSession: false,
                    autoRefreshToken: false,
                    detectSessionInUrl: false
                }
            }
        );

        const body = await request.json();
        const { content } = body;

        if (!content || content.trim().length === 0) {
            return NextResponse.json({ error: '评论内容不能为空' }, { status: 400 });
        }

        if (content.length > 2000) {
            return NextResponse.json({ error: '评论内容不能超过2000字' }, { status: 400 });
        }

        // 调用 RPC 函数更新评论
        const { data: updatedComment, error } = await supabase.rpc('edit_comment', {
            p_comment_id: commentId,
            p_content: content.trim()
        });

        if (error) {
            console.error('RPC edit_comment failed:', error);
            let status = 500;
            let msg = '更新评论失败';

            if (error.message.includes('Not authenticated')) {
                status = 401;
                msg = '未登录或登录过期';
            } else if (error.message.includes('Permission denied')) {
                status = 403;
                msg = '无权编辑此评论';
            } else if (error.message.includes('Comment not found')) {
                status = 404;
                msg = '评论不存在';
            }

            return NextResponse.json({ error: msg }, { status });
        }

        return NextResponse.json({ comment: updatedComment });
    } catch (error) {
        console.error('更新评论异常:', error);
        return NextResponse.json({ error: '服务器错误' }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    props: { params: Promise<{ commentId: string }> }
) {
    const params = await props.params;
    try {
        const commentId = params.commentId;
        const authHeader = request.headers.get('Authorization');

        if (!authHeader) {
            return NextResponse.json({ error: '未授权' }, { status: 401 });
        }

        // 使用 Anon Key + 用户 Token 创建客户端
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: {
                    headers: {
                        Authorization: authHeader,
                    },
                },
                auth: {
                    persistSession: false,
                    autoRefreshToken: false,
                    detectSessionInUrl: false
                }
            }
        );

        // 调用 RPC 函数删除评论
        const { error } = await supabase.rpc('delete_comment', {
            p_comment_id: commentId
        });

        if (error) {
            console.error('RPC delete_comment failed:', error);
            let status = 500;
            let msg = '删除评论失败';

            if (error.message.includes('Not authenticated')) {
                status = 401;
                msg = '未登录或登录过期';
            } else if (error.message.includes('Permission denied')) {
                status = 403;
                msg = '无权删除此评论';
            } else if (error.message.includes('Comment not found')) {
                status = 404;
                msg = '评论不存在';
            }

            return NextResponse.json({ error: msg }, { status });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('删除评论异常:', error);
        return NextResponse.json({ error: '服务器错误' }, { status: 500 });
    }
}
