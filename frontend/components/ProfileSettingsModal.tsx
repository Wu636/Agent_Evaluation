'use client';

import { useState, useEffect } from 'react';
import { X, User, Loader2 } from 'lucide-react';
import { useAuth } from './AuthProvider';

interface ProfileSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function ProfileSettingsModal({ isOpen, onClose }: ProfileSettingsModalProps) {
    const { user } = useAuth();
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    // 加载用户当前的名字
    useEffect(() => {
        if (isOpen && user) {
            setLoading(true);
            setError(null);
            fetch('/api/profile')
                .then(res => res.json())
                .then(data => {
                    if (data.profile?.name) {
                        setName(data.profile.name);
                    } else {
                        // 如果没有设置过名字，使用邮箱前缀作为默认值
                        setName(user.email?.split('@')[0] || '');
                    }
                })
                .catch(err => {
                    console.error('Failed to load profile:', err);
                    setError('加载个人资料失败');
                })
                .finally(() => setLoading(false));
        }
    }, [isOpen, user]);

    const handleSave = async () => {
        if (!name.trim()) {
            setError('名字不能为空');
            return;
        }

        setSaving(true);
        setError(null);
        setSuccess(false);

        try {
            const res = await fetch('/api/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim() })
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || '保存失败');
            }

            setSuccess(true);
            setTimeout(() => {
                onClose();
                // 刷新页面以更新所有显示的名字
                window.location.reload();
            }, 1000);
        } catch (err: any) {
            setError(err.message || '保存失败，请重试');
        } finally {
            setSaving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
                            <User className="w-5 h-5 text-indigo-600" />
                        </div>
                        <h2 className="text-xl font-bold text-slate-900">个人资料</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
                    >
                        <X className="w-5 h-5 text-slate-400" />
                    </button>
                </div>

                {/* Content */}
                <div className="space-y-4">
                    {/* Email (readonly) */}
                    <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                            邮箱
                        </label>
                        <input
                            type="email"
                            value={user?.email || ''}
                            disabled
                            className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-500 cursor-not-allowed"
                        />
                    </div>

                    {/* Display Name */}
                    <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                            显示名称
                        </label>
                        {loading ? (
                            <div className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center gap-2">
                                <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                                <span className="text-sm text-slate-400">加载中...</span>
                            </div>
                        ) : (
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="请输入显示名称"
                                className="w-full px-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                                disabled={saving}
                            />
                        )}
                        <p className="mt-1.5 text-xs text-slate-500">
                            此名称将在评论和通知中显示
                        </p>
                    </div>

                    {/* Error Message */}
                    {error && (
                        <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
                            {error}
                        </div>
                    )}

                    {/* Success Message */}
                    {success && (
                        <div className="p-3 bg-emerald-50 border border-emerald-100 rounded-lg text-sm text-emerald-700">
                            保存成功！
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex gap-3 mt-6">
                    <button
                        onClick={onClose}
                        disabled={saving}
                        className="flex-1 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        取消
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving || loading || !name.trim()}
                        className="flex-1 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {saving ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                保存中...
                            </>
                        ) : (
                            '保存'
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
