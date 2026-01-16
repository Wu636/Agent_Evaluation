import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { createClient } from '@supabase/supabase-js';

export async function GET(
    request: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    const start = Date.now();
    const params = await props.params;
    try {
        const evaluationId = params.id;

        // 获取评论，按创建时间倒序
        const { data: comments, error } = await supabaseAdmin
            .from('evaluation_comments')
            .select('*')
            .eq('evaluation_id', evaluationId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('获取评论失败:', error);
            return NextResponse.json({ error: '获取评论失败' }, { status: 500 });
        }

        // 组织评论结构（将回复嵌套到父评论下）
        const commentMap = new Map();
        const rootComments: any[] = [];

        // 第一遍：创建所有评论的映射
        comments?.forEach(comment => {
            commentMap.set(comment.id, { ...comment, replies: [] });
        });

        // 第二遍：构建树形结构
        comments?.forEach(comment => {
            const commentWithReplies = commentMap.get(comment.id);
            if (comment.parent_comment_id) {
                const parent = commentMap.get(comment.parent_comment_id);
                if (parent) {
                    parent.replies.push(commentWithReplies);
                }
            } else {
                rootComments.push(commentWithReplies);
            }
        });

        console.log(`GET Comments took ${Date.now() - start}ms`);
        return NextResponse.json({ comments: rootComments });
    } catch (error) {
        console.error('获取评论异常:', error);
        return NextResponse.json({ error: '服务器错误' }, { status: 500 });
    }
}

export async function POST(
    request: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    const start = Date.now();
    const params = await props.params;
    try {
        const evaluationId = params.id;
        const authHeader = request.headers.get('Authorization');

        if (!authHeader) {
            return NextResponse.json({ error: '未授权' }, { status: 401 });
        }

        // 使用 Anon Key + 用户 Token 创建客户端
        // 这样可以直接利用 Postgres 的 auth.uid() 功能，且不需要额外的 auth.getUser 请求
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
        const { content, parent_comment_id, mentioned_user_ids } = body;

        if (!content || content.trim().length === 0) {
            return NextResponse.json({ error: '评论内容不能为空' }, { status: 400 });
        }

        if (content.length > 2000) {
            return NextResponse.json({ error: '评论内容不能超过2000字' }, { status: 400 });
        }

        // 调用 RPC 函数处理所有逻辑（获取用户、验证权限、插入评论）
        // 这将之前需要的 4 次请求（Auth, Profile, Evaluation, Insert）减少为 1 次
        const { data: comment, error } = await supabase.rpc('post_comment', {
            p_evaluation_id: evaluationId,
            p_content: content.trim(),
            p_parent_comment_id: parent_comment_id || null,
            p_mentioned_user_ids: mentioned_user_ids || []
        });

        if (error) {
            console.error('RPC post_comment failed:', error);
            // 简单映射错误信息
            let status = 500;
            let msg = '创建评论失败';

            if (error.message.includes('Not authenticated')) {
                status = 401;
                msg = '未登录或登录过期';
            } else if (error.message.includes('Permission denied')) {
                status = 403;
                msg = '无权在此报告上评论';
            } else if (error.message.includes('Evaluation not found')) {
                status = 404;
                msg = '评估报告不存在';
            }

            return NextResponse.json({ error: msg }, { status });
        }

        console.log(`POST Comment (RPC) took ${Date.now() - start}ms`);
        return NextResponse.json({ comment }, { status: 201 });
    } catch (error) {
        console.error('创建评论异常:', error);
        return NextResponse.json({ error: '服务器错误' }, { status: 500 });
    }
}

export async function PATCH(
    request: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    const start = Date.now();
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader) {
            return NextResponse.json({ error: '未授权' }, { status: 401 });
        }

        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: { headers: { Authorization: authHeader } },
                auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
            }
        );

        const body = await request.json();
        const { comment_id, content } = body;

        if (!comment_id || !content) {
            return NextResponse.json({ error: '缺少参数' }, { status: 400 });
        }

        const { data, error } = await supabase.rpc('edit_comment', {
            p_comment_id: comment_id,
            p_content: content
        });

        if (error) {
            console.error('RPC edit_comment failed:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        console.log(`PATCH Comment (RPC) took ${Date.now() - start}ms`);
        return NextResponse.json({ comment: data });
    } catch (error) {
        console.error('更新评论异常:', error);
        return NextResponse.json({ error: '服务器错误' }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    const start = Date.now();
    try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader) {
            return NextResponse.json({ error: '未授权' }, { status: 401 });
        }

        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: { headers: { Authorization: authHeader } },
                auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
            }
        );

        const { searchParams } = new URL(request.url);
        const comment_id = searchParams.get('comment_id');

        if (!comment_id) {
            return NextResponse.json({ error: '缺少 comment_id 参数' }, { status: 400 });
        }

        const { error } = await supabase.rpc('delete_comment', {
            p_comment_id: comment_id
        });

        if (error) {
            console.error('RPC delete_comment failed:', error);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        console.log(`DELETE Comment (RPC) took ${Date.now() - start}ms`);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('删除评论异常:', error);
        return NextResponse.json({ error: '服务器错误' }, { status: 500 });
    }
}
