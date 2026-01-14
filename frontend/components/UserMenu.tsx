'use client';

import { useState, useRef, useEffect } from 'react';
import { User, LogOut, Settings, Share2, ChevronDown, AlertTriangle } from 'lucide-react';
import { useAuth } from './AuthProvider';
import { supabase } from '@/lib/supabase';

interface UserMenuProps {
    onLoginClick: () => void;
}

export function UserMenu({ onLoginClick }: UserMenuProps) {
    const { user, loading, signOut, isGuest } = useAuth();
    const [isOpen, setIsOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // 点击外部关闭菜单
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    if (loading) {
        return (
            <div className="w-8 h-8 rounded-full bg-slate-200 animate-pulse" />
        );
    }

    if (!user || isGuest) {
        return (
            <button
                onClick={onLoginClick}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isGuest 
                        ? 'text-slate-700 bg-slate-200 hover:bg-slate-300' 
                        : 'text-white bg-indigo-600 hover:bg-indigo-700'
                }`}
            >
                <User className="w-4 h-4" />
                {isGuest ? '游客模式' : '登录'}
            </button>
        );
    }

    const avatarUrl = user.user_metadata?.avatar_url;
    const displayName = user.user_metadata?.name || user.email?.split('@')[0] || '用户';

    const handleDeleteAccount = async () => {
        if (!confirm('⚠️ 警告：账号注销后将无法恢复，所有数据将被永久删除！\n\n确定要注销账号吗？')) {
            return;
        }

        try {
            // 先删除用户数据
            const { error: deleteDataError } = await supabase
                .from('evaluations')
                .delete()
                .eq('user_id', user!.id);

            if (deleteDataError) {
                console.warn('删除用户数据失败:', deleteDataError);
            }

            // 删除用户资料
            const { error: deleteProfileError } = await supabase
                .from('profiles')
                .delete()
                .eq('id', user!.id);

            if (deleteProfileError) {
                console.warn('删除用户资料失败:', deleteProfileError);
            }
            
            setIsOpen(false);
            signOut();
            alert('账号已成功注销');
        } catch (error: any) {
            console.error('注销账号失败:', error);
            alert('注销账号失败：' + (error.message || '未知错误'));
        }
    };

    return (
        <div className="relative" ref={menuRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-100 hover:bg-slate-200 transition-colors"
            >
                {avatarUrl ? (
                    <img
                        src={avatarUrl}
                        alt={displayName}
                        className="w-7 h-7 rounded-full object-cover"
                    />
                ) : (
                    <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-sm font-medium">
                        {displayName[0].toUpperCase()}
                    </div>
                )}
                <span className="text-sm font-medium text-slate-700 max-w-[100px] truncate">
                    {displayName}
                </span>
                <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown Menu */}
            {isOpen && (
                <div className="absolute right-0 mt-2 w-48 bg-white rounded-xl shadow-lg border border-slate-100 py-2 animate-in fade-in slide-in-from-top-2 duration-150 z-50">
                    <div className="px-4 py-2 border-b border-slate-100">
                        <p className="text-sm font-medium text-slate-900 truncate">{displayName}</p>
                        <p className="text-xs text-slate-500 truncate">{user.email}</p>
                    </div>

                    <button
                        onClick={() => {
                            setIsOpen(false);
                            // TODO: 打开我的分享页面
                        }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                        <Share2 className="w-4 h-4 text-slate-400" />
                        我的分享
                    </button>

                    <button
                        onClick={() => {
                            setIsOpen(false);
                            signOut();
                        }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                        <LogOut className="w-4 h-4 text-slate-400" />
                        退出登录
                    </button>

                    <div className="border-t border-slate-100 my-1"></div>

                    <button
                        onClick={handleDeleteAccount}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                        <AlertTriangle className="w-4 h-4" />
                        注销账号
                    </button>
                </div>
            )}
        </div>
    );
}
