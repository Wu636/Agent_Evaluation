import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const authHeader = request.headers.get('authorization');
        if (!authHeader) {
            return NextResponse.json({ error: '未登录' }, { status: 401 });
        }

        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: authHeader } },
            auth: { persistSession: false }
        });

        const { error } = await supabase.rpc('mark_notification_read', {
            p_notification_id: id
        });

        if (error) throw error;

        return NextResponse.json({ success: true });

    } catch (error) {
        console.error('Mark read error:', error);
        return NextResponse.json({ error: '操作失败' }, { status: 500 });
    }
}
