import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

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

    } catch (error) {
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
        return NextResponse.json({ error: '操作失败' }, { status: 500 });
    }
}
