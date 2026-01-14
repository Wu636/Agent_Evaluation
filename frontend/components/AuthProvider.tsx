'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

interface AuthContextType {
    user: User | null;
    session: Session | null;
    loading: boolean;
    isGuest: boolean;
    signOut: () => Promise<void>;
    setGuestMode: (isGuest: boolean) => void;
}

const AuthContext = createContext<AuthContextType>({
    user: null,
    session: null,
    loading: true,
    isGuest: false,
    signOut: async () => { },
    setGuestMode: () => { },
});

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const [isGuest, setIsGuest] = useState(false);

    useEffect(() => {
        // 检查游客模式
        const guestMode = localStorage.getItem('guest_mode') === 'true';
        setIsGuest(guestMode);

        // 如果 Supabase 未配置，设置为游客模式
        if (!supabase) {
            setIsGuest(true);
            setLoading(false);
            return;
        }

        // 获取初始 session
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setUser(session?.user ?? null);

            // 如果有登录用户，清除游客模式
            if (session?.user) {
                setIsGuest(false);
                localStorage.removeItem('guest_mode');
            }

            setLoading(false);
        });

        // 监听认证状态变化
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            async (event, session) => {
                setSession(session);
                setUser(session?.user ?? null);
                setLoading(false);

                // 登录后尝试同步本地数据
                if (event === 'SIGNED_IN' && session?.user) {
                    setIsGuest(false);
                    localStorage.removeItem('guest_mode');
                    syncLocalData(session.user.id);
                }
            }
        );

        return () => subscription.unsubscribe();
    }, []);

    const signOut = async () => {
        if (supabase) {
            await supabase.auth.signOut();
        }
        setUser(null);
        setSession(null);
        setIsGuest(false);
        localStorage.removeItem('guest_mode');
    };

    const setGuestMode = (guest: boolean) => {
        setIsGuest(guest);
        if (guest) {
            localStorage.setItem('guest_mode', 'true');
        } else {
            localStorage.removeItem('guest_mode');
        }
    };

    return (
        <AuthContext.Provider value={{ user, session, loading, isGuest, signOut, setGuestMode }}>
            {children}
        </AuthContext.Provider>
    );
}

export const useAuth = () => useContext(AuthContext);

// 同步 localStorage 数据到 Supabase
async function syncLocalData(userId: string) {
    if (!supabase) return; // Supabase 未配置则跳过同步

    try {
        const localHistory = localStorage.getItem('evaluation_history');
        if (!localHistory) return;

        const historyItems = JSON.parse(localHistory);
        if (!Array.isArray(historyItems) || historyItems.length === 0) return;

        console.log(`[Sync] 发现 ${historyItems.length} 条本地记录，开始同步...`);

        for (const item of historyItems) {
            // 检查是否已存在（通过 created_at 时间戳）
            const { data: existing } = await supabase
                .from('evaluations')
                .select('id')
                .eq('user_id', userId)
                .eq('created_at', item.timestamp || item.created_at)
                .single();

            if (existing) continue; // 已存在则跳过

            // 插入到 Supabase
            await supabase.from('evaluations').insert({
                user_id: userId,
                teacher_doc_name: item.teacherDocName || item.teacher_doc_name || 'unknown',
                teacher_doc_content: '', // 本地记录可能没有完整内容
                dialogue_record_name: item.dialogueRecordName || item.dialogue_record_name || 'unknown',
                dialogue_data: null,
                total_score: item.report?.total_score || item.totalScore || 0,
                final_level: item.report?.final_level || item.finalLevel || '',
                veto_reasons: item.report?.veto_reasons || [],
                model_used: item.modelName || item.model_used || '',
                dimensions: item.report?.dimensions || [],
                is_public: false,
                created_at: item.timestamp || item.created_at || new Date().toISOString(),
            });
        }

        console.log('[Sync] 本地数据同步完成');
        // 清除已同步的本地数据
        // localStorage.removeItem('evaluation_history'); // 可选：同步后清除本地
    } catch (error) {
        console.error('[Sync] 同步失败:', error);
    }
}
