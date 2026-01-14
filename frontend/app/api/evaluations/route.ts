import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// GET: 获取用户的评测列表
export async function GET(request: NextRequest) {
    try {
        const supabase = createClient(supabaseUrl, supabaseServiceKey);

        // 从 header 获取用户 token
        const authHeader = request.headers.get('authorization');
        if (!authHeader) {
            return NextResponse.json({ error: '未登录' }, { status: 401 });
        }

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
            return NextResponse.json({ error: '认证失败' }, { status: 401 });
        }

        // 获取用户的评测
        const { data, error } = await supabase
            .from('evaluations')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        return NextResponse.json({ evaluations: data });

    } catch (error) {
        console.error('获取评测列表失败:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '获取失败' },
            { status: 500 }
        );
    }
}

// POST: 保存新评测
export async function POST(request: NextRequest) {
    try {
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
        const {
            teacherDocName,
            teacherDocContent,
            dialogueRecordName,
            dialogueData,
            report,
            modelUsed
        } = body;

        // 插入评测记录
        const { data, error } = await supabase
            .from('evaluations')
            .insert({
                user_id: user.id,
                teacher_doc_name: teacherDocName,
                teacher_doc_content: teacherDocContent,
                dialogue_record_name: dialogueRecordName,
                dialogue_data: dialogueData,
                total_score: report.total_score,
                final_level: report.final_level,
                veto_reasons: report.veto_reasons || [],
                model_used: modelUsed,
                dimensions: report.dimensions,
                is_public: false, // 默认私有
            })
            .select()
            .single();

        if (error) throw error;

        return NextResponse.json({
            success: true,
            evaluation: data
        });

    } catch (error) {
        console.error('保存评测失败:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : '保存失败' },
            { status: 500 }
        );
    }
}
