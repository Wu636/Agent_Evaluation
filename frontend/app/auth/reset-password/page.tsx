'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import {
    AlertCircle,
    CheckCircle2,
    Eye,
    EyeOff,
    KeyRound,
    Loader2,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

type PageStatus = 'checking' | 'ready' | 'invalid' | 'success';

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapLinkError(code: string | null, message: string) {
    const combined = `${code || ''} ${message}`.toLowerCase();
    if (combined.includes('expired')) {
        return '重置链接已过期，请返回首页重新申请重置邮件。';
    }
    if (combined.includes('invalid') || combined.includes('access_denied')) {
        return '重置链接无效，请返回首页重新申请重置邮件。';
    }
    return '重置链接无效或已过期，请返回首页重新申请重置邮件。';
}

export default function ResetPasswordPage() {
    const [status, setStatus] = useState<PageStatus>('checking');
    const [linkError, setLinkError] = useState('');
    const [accountEmail, setAccountEmail] = useState('');

    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!supabase) {
            setLinkError('Supabase 未配置，无法重置密码');
            setStatus('invalid');
            return;
        }

        const client = supabase;
        let active = true;

        // 解析链接中可能携带的错误（过期、已使用等）
        const params = new URLSearchParams(window.location.search);
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const rawError =
            params.get('error_description') ||
            hashParams.get('error_description') ||
            params.get('error') ||
            hashParams.get('error');
        const errorCode = params.get('error_code') || hashParams.get('error_code');

        if (rawError) {
            setLinkError(mapLinkError(errorCode, decodeURIComponent(rawError.replace(/\+/g, ' '))));
            setStatus('invalid');
            return;
        }

        const markReady = () => {
            if (!active) return;
            setStatus((prev) => (prev === 'success' ? prev : 'ready'));
        };

        const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
            if (session && (event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY')) {
                if (session.user?.email) setAccountEmail(session.user.email);
                markReady();
            }
        });

        // 邮件链接中的 code 由浏览器端自动兑换，需要等待会话建立
        const detectSession = async () => {
            for (let attempt = 0; attempt < 10; attempt += 1) {
                const { data } = await client.auth.getSession();
                if (data.session) {
                    if (data.session.user?.email) setAccountEmail(data.session.user.email);
                    markReady();
                    return;
                }
                await sleep(400);
            }
            if (active) {
                setLinkError(
                    '重置链接无效或已过期，请返回首页重新申请重置邮件。如果邮件是在其他浏览器或设备中打开的，请回到发起重置的浏览器中打开链接。'
                );
                setStatus('invalid');
            }
        };

        void detectSession();

        return () => {
            active = false;
            subscription.unsubscribe();
        };
    }, []);

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (!supabase) return;

        setFormError('');

        if (password.length < 6) {
            setFormError('新密码长度至少 6 位');
            return;
        }
        if (password !== confirmPassword) {
            setFormError('两次输入的密码不一致');
            return;
        }

        setSaving(true);
        try {
            const { error } = await supabase.auth.updateUser({ password });
            if (error) throw error;
            setPassword('');
            setConfirmPassword('');
            setStatus('success');
        } catch (error: any) {
            const message: string = error?.message || '';
            if (message.toLowerCase().includes('should be different')) {
                setFormError('新密码不能与旧密码相同');
            } else if (message.toLowerCase().includes('session')) {
                setFormError('登录状态已失效，请重新打开重置邮件中的链接');
            } else {
                setFormError(message || '密码更新失败，请稍后重试');
            }
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="min-h-[calc(100vh-4rem)] bg-slate-50 flex items-center justify-center px-4 py-12">
            <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-100 p-8">
                <div className="text-center mb-6">
                    <div className="w-12 h-12 mx-auto rounded-full bg-indigo-50 flex items-center justify-center mb-3">
                        <KeyRound className="w-6 h-6 text-indigo-600" />
                    </div>
                    <h1 className="text-2xl font-bold text-slate-900">重置密码</h1>
                    <p className="text-slate-500 mt-2 text-sm">
                        {status === 'success'
                            ? '密码已更新，可使用新密码登录'
                            : '设置一个新的登录密码'}
                    </p>
                </div>

                {status === 'checking' && (
                    <div className="flex flex-col items-center gap-3 text-slate-500 py-10">
                        <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
                        <p className="text-sm">正在验证重置链接…</p>
                    </div>
                )}

                {status === 'invalid' && (
                    <div className="space-y-5 text-center py-2">
                        <div className="w-14 h-14 mx-auto rounded-full bg-red-50 flex items-center justify-center">
                            <AlertCircle className="w-7 h-7 text-red-500" />
                        </div>
                        <p className="text-sm text-slate-600 leading-relaxed">{linkError}</p>
                        <Link
                            href="/"
                            className="block w-full px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium transition-colors"
                        >
                            返回首页
                        </Link>
                        <p className="text-xs text-slate-400">
                            在登录弹窗中点击「忘记密码？」可重新发送重置邮件
                        </p>
                    </div>
                )}

                {status === 'ready' && (
                    <form onSubmit={handleSubmit} className="space-y-4">
                        {accountEmail && (
                            <p className="text-xs text-slate-500 text-center">
                                正在为 <span className="font-medium text-slate-700">{accountEmail}</span> 设置新密码
                            </p>
                        )}

                        {formError && (
                            <div className="p-3 rounded-lg text-sm bg-red-50 text-red-700">
                                {formError}
                            </div>
                        )}

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">
                                新密码
                            </label>
                            <div className="relative">
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none pr-10"
                                    placeholder="至少 6 位"
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

                        <div>
                            <label className="block text-sm font-medium text-slate-700 mb-1.5">
                                确认新密码
                            </label>
                            <input
                                type={showPassword ? 'text' : 'password'}
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                className="w-full px-4 py-2.5 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                                placeholder="再次输入新密码"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={saving}
                            className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium transition-colors"
                        >
                            {saving ? '保存中...' : '保存新密码'}
                        </button>
                    </form>
                )}

                {status === 'success' && (
                    <div className="space-y-5 text-center py-2">
                        <div className="w-14 h-14 mx-auto rounded-full bg-emerald-50 flex items-center justify-center">
                            <CheckCircle2 className="w-7 h-7 text-emerald-500" />
                        </div>
                        <p className="text-sm text-slate-600 leading-relaxed">
                            新密码已生效，当前设备已自动登录。其他设备上的登录状态不受影响，如需退出请在各设备手动退出。
                        </p>
                        <Link
                            href="/"
                            className="block w-full px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium transition-colors"
                        >
                            进入工作台
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
