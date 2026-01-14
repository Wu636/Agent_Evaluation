'use client';

import { useEffect, useState } from 'react';
import { X, CheckCircle, User, Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface EnhancedLoginModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type LoginMode = 'email' | 'guest';

export function EnhancedLoginModal({ isOpen, onClose }: EnhancedLoginModalProps) {
    const [loginMode, setLoginMode] = useState<LoginMode>('email');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');

    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // 监听登录状态变化，登录成功后自动关闭弹窗
    useEffect(() => {
        if (!supabase) return;

        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session) {
                onClose();
            }
        });

        return () => subscription.unsubscribe();
    }, [onClose]);

    // 重置表单状态
    useEffect(() => {
        if (isOpen) {
            setEmail('');
            setPassword('');
            setError('');
            setLoading(false);
        }
    }, [isOpen]);

    const handleEmailLogin = async () => {
        if (!supabase) {
            setError('Supabase 未配置，请使用游客模式');
            return;
        }

        if (!email || !password) {
            setError('请填写邮箱和密码');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const { error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });

            if (error) throw error;
        } catch (error: any) {
            setError(error.message || '登录失败');
        } finally {
            setLoading(false);
        }
    };

    const handleEmailRegister = async () => {
        if (!supabase) {
            setError('Supabase 未配置，请使用游客模式');
            return;
        }

        if (!email || !password) {
            setError('请填写邮箱和密码');
            return;
        }

        setLoading(true);
        setError('');

        try {
            const { error } = await supabase.auth.signUp({
                email,
                password,
                options: {
                    emailRedirectTo: `${window.location.origin}/auth/callback`,
                    data: {
                        skip_email_verification: false
                    }
                }
            });

            if (error) throw error;

            // 显示注册成功消息
            setError('注册成功！请检查邮箱（如果需要验证）');
        } catch (error: any) {
            setError(error.message || '注册失败');
        } finally {
            setLoading(false);
        }
    };



    const handleGuestMode = () => {
        // 设置游客模式标志
        localStorage.setItem('guest_mode', 'true');
        onClose();
    };

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
                    <p className="text-slate-500 mt-2">选择登录方式以保存评测记录</p>
                </div>

                {/* Login Mode Tabs */}
                <div className="flex gap-2 mb-6 bg-slate-100 p-1 rounded-lg">
                    <button
                        onClick={() => setLoginMode('email')}
                        className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${loginMode === 'email'
                            ? 'bg-white text-indigo-600 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                            }`}
                    >
                        <Mail className="w-4 h-4 inline mr-1" />
                        邮箱
                    </button>

                    <button
                        onClick={() => setLoginMode('guest')}
                        className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${loginMode === 'guest'
                            ? 'bg-white text-indigo-600 shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                            }`}
                    >
                        游客模式
                    </button>
                </div>

                {/* Error Message */}
                {error && (
                    <div className={`mb-4 p-3 rounded-lg text-sm ${error.includes('成功')
                        ? 'bg-green-50 text-green-700'
                        : 'bg-red-50 text-red-700'
                        }`}>
                        {error}
                    </div>
                )}

                {/* Email Login Form */}
                {loginMode === 'email' && (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">
                                邮箱
                            </label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                                placeholder="your@email.com"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">
                                密码
                            </label>
                            <div className="relative">
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none pr-10"
                                    placeholder="••••••••"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                                >
                                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>
                        <div className="space-y-3">
                            <div className="flex gap-3">
                                <button
                                    onClick={handleEmailLogin}
                                    disabled={loading}
                                    className="flex-1 w-full px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                                >
                                    {loading ? '登录中...' : '登录'}
                                </button>
                                <button
                                    onClick={handleEmailRegister}
                                    disabled={loading}
                                    className="flex-1 w-full px-4 py-2.5 bg-white text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                                >
                                    {loading ? '注册中...' : '注册'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}


                {/* Guest Mode */}
                {loginMode === 'guest' && (
                    <div className="text-center py-6">
                        <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                            <User className="w-8 h-8 text-slate-400" />
                        </div>
                        <h3 className="text-lg font-medium text-slate-900 mb-2">游客模式</h3>
                        <p className="text-slate-500 mb-6 text-sm">
                            无需注册即可使用评测功能，数据将保存在本地浏览器中。<br />
                            更换设备或清除浏览器数据后记录将丢失。
                        </p>
                        <button
                            onClick={handleGuestMode}
                            className="w-full px-4 py-2.5 bg-slate-600 text-white rounded-lg hover:bg-slate-700 font-medium transition-colors"
                        >
                            以游客身份继续
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}