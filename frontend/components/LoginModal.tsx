'use client';

import { useEffect } from 'react';
import { X, CheckCircle } from 'lucide-react';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '@/lib/supabase';

interface LoginModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function LoginModal({ isOpen, onClose }: LoginModalProps) {
    // 监听登录状态变化，登录成功后自动关闭弹窗
    useEffect(() => {
        if (!supabase) return;

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session) {
                // 登录成功，自动关闭弹窗
                onClose();
            }
        });

        return () => subscription.unsubscribe();
    }, [onClose]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-8 animate-in fade-in zoom-in duration-200">
                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                    <X className="w-5 h-5" />
                </button>

                {/* Header */}
                <div className="text-center mb-6">
                    <h2 className="text-2xl font-bold text-slate-900">登录 / 注册</h2>
                    <p className="text-slate-500 mt-2">登录后可保存评测记录并分享给他人</p>
                </div>

                {/* Supabase Auth UI */}
                {supabase ? (
                    <Auth
                        supabaseClient={supabase}
                        appearance={{
                            theme: ThemeSupa,
                            variables: {
                                default: {
                                    colors: {
                                        brand: '#4f46e5',
                                        brandAccent: '#4338ca',
                                    }
                                }
                            },
                            className: {
                                container: 'w-full',
                                button: 'w-full px-4 py-2.5 rounded-lg font-medium transition-colors',
                                input: 'w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
                                label: 'text-sm font-medium text-slate-700 mb-1.5',
                            }
                        }}
                        localization={{
                            variables: {
                                sign_in: {
                                    email_label: '邮箱',
                                    password_label: '密码',
                                    button_label: '登录',
                                    link_text: '已有账号？登录',
                                },
                                sign_up: {
                                    email_label: '邮箱',
                                    password_label: '密码',
                                    button_label: '注册',
                                    link_text: '没有账号？注册',
                                },
                            },
                        }}
                        providers={[]}
                        redirectTo={typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : undefined}
                    />
                ) : (
                    <div className="text-center py-8">
                        <p className="text-slate-500 mb-4">Supabase 未配置</p>
                        <p className="text-sm text-slate-400">管理员需要在环境变量中配置 Supabase 才能使用登录功能。</p>
                        <button
                            onClick={onClose}
                            className="mt-4 px-4 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-700"
                        >
                            知道了
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
