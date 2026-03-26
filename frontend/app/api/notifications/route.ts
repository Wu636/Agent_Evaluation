import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function isSupabaseTransientError(error: unknown): boolean {
    const anyError = error as { message?: string; details?: string; code?: string };
    const combined = `${anyError?.message || ""} ${anyError?.details || ""} ${anyError?.code || ""}`.toLowerCase();
    return (
        combined.includes('fetch failed') ||
        combined.includes('timeout') ||
        combined.includes('connecttimeouterror') ||
        combined.includes('und_err_connect_timeout') ||
        combined.includes('econnrefused') ||
        combined.includes('enotfound')
    );
}

export async function GET(request: NextRequest) {
    try {
        const authHeader = request.headers.get('authorization');
        if (!authHeader) {
            return NextResponse.json({ error: '未登录' }, { status: 401 });
        }

        const token = authHeader.replace('Bearer ', '');
        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: authHeader } },
            auth: { persistSession: false }
        });

        // 获取通知列表
        const { data: notifications, error } = await supabase
            .from('notifications')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        // 获取未读数量
        const { data: countData, error: countError } = await supabase.rpc('get_unread_notifications_count');

        if (countError) throw countError;

        return NextResponse.json({
            notifications,
            unread_count: countData
        });

    } catch (error: any) {
        // JWT 过期属于正常情况（用户闲置），返回 401 而非 500
        if (error?.code === 'PGRST303' || error?.message?.includes('JWT expired')) {
            return NextResponse.json({ error: 'JWT expired' }, { status: 401 });
        }
        if (isSupabaseTransientError(error)) {
            console.warn('Fetch notifications degraded due to Supabase timeout:', error);
            return NextResponse.json({
                notifications: [],
                unread_count: 0,
                degraded: true,
                error: '通知服务暂时不可用',
            });
        }
        console.error('Fetch notifications error:', error);
        return NextResponse.json({ error: '获取通知失败' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    // Mark ALL as read
    try {
        const authHeader = request.headers.get('authorization');
        if (!authHeader) {
            return NextResponse.json({ error: '未登录' }, { status: 401 });
        }

        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: authHeader } },
            auth: { persistSession: false }
        });

        const { error } = await supabase.rpc('mark_all_notifications_read');

        if (error) throw error;

        return NextResponse.json({ success: true });

    } catch (error) {
        console.error('Mark all read error:', error);
        if (isSupabaseTransientError(error)) {
            return NextResponse.json({ error: '通知服务暂时不可用', degraded: true }, { status: 503 });
        }
        return NextResponse.json({ error: '操作失败' }, { status: 500 });
    }
}
