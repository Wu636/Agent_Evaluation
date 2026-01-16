import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const query = searchParams.get('q');

        if (!query || query.length < 1) {
            return NextResponse.json({ users: [] });
        }

        const authHeader = request.headers.get('authorization');
        if (!authHeader) {
            return NextResponse.json({ error: '未登录' }, { status: 401 });
        }

        const supabase = createClient(supabaseUrl, supabaseAnonKey, {
            global: { headers: { Authorization: authHeader } },
            auth: { persistSession: false }
        });

        const { data: users, error } = await supabase.rpc('search_users', {
            p_query: query
        });

        if (error) throw error;

        return NextResponse.json({ users });

    } catch (error) {
        console.error('Search users error:', error);
        return NextResponse.json({ error: '搜索用户失败' }, { status: 500 });
    }
}
