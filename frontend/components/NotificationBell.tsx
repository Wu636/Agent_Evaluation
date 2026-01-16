"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Bell, Check, MessageSquare, AtSign, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useAuth } from './AuthProvider';
import clsx from 'clsx';
import { useRouter } from 'next/navigation';

interface Notification {
    id: string;
    actor_name: string;
    type: 'comment' | 'reply' | 'mention';
    resource_id: string;
    meta_data: {
        snippet?: string;
        evaluation_title?: string;
        comment_id?: string;
    };
    is_read: boolean;
    created_at: string;
}

export function NotificationBell() {
    const { session } = useAuth();
    const router = useRouter();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [isOpen, setIsOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Initial fetch and polling
    useEffect(() => {
        if (session?.access_token) {
            fetchNotifications();
            // Poll every 60 seconds
            const interval = setInterval(fetchNotifications, 60000);
            return () => clearInterval(interval);
        }
    }, [session]);

    // Click outside to close
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const fetchNotifications = async () => {
        if (!session?.access_token) return;
        try {
            const res = await fetch('/api/notifications', {
                headers: { 'Authorization': `Bearer ${session.access_token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setNotifications(data.notifications || []);
                setUnreadCount(data.unread_count || 0);
            }
        } catch (error) {
            console.error('Failed to fetch notifications', error);
        }
    };

    const handleMarkRead = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!session?.access_token) return;

        // Optimistic update
        setNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
        setUnreadCount(prev => Math.max(0, prev - 1));

        try {
            await fetch(`/api/notifications/${id}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${session.access_token}` }
            });
        } catch (error) {
            console.error('Failed to mark read', error);
        }
    };

    const handleMarkAllRead = async () => {
        if (!session?.access_token) return;

        setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
        setUnreadCount(0);

        try {
            await fetch('/api/notifications', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${session.access_token}` }
            });
        } catch (error) {
            console.error('Failed to mark all read', error);
        }
    };

    const handleNotificationClick = async (n: Notification) => {
        if (!n.is_read) {
            handleMarkRead(n.id, { stopPropagation: () => { } } as any);
        }
        setIsOpen(false);

        // Redirect to report with comment highlight
        if (n.resource_id) {
            const url = `/report/${n.resource_id}?commentId=${n.meta_data?.comment_id}`;
            router.push(url);
        }
    };

    const getIcon = (type: string) => {
        switch (type) {
            case 'mention': return <AtSign className="w-4 h-4 text-purple-600" />;
            case 'reply': return <MessageSquare className="w-4 h-4 text-blue-600" />;
            default: return <Bell className="w-4 h-4 text-slate-600" />;
        }
    };

    const formatDate = (isoStr: string) => {
        const date = new Date(isoStr);
        const now = new Date();
        const diff = now.getTime() - date.getTime();

        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
        return `${Math.floor(diff / 86400000)}天前`;
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="relative p-2 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-full transition-colors"
            >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white animate-pulse" />
                )}
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-xl border border-slate-100 overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-200">
                    <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                        <h3 className="font-bold text-slate-700 text-sm">通知中心</h3>
                        {unreadCount > 0 && (
                            <button
                                onClick={handleMarkAllRead}
                                className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                            >
                                全部已读
                            </button>
                        )}
                    </div>

                    <div className="max-h-96 overflow-y-auto">
                        {notifications.length === 0 ? (
                            <div className="py-8 text-center text-slate-400 text-sm">
                                暂无通知
                            </div>
                        ) : (
                            <div className="divide-y divide-slate-50">
                                {notifications.map(n => (
                                    <div
                                        key={n.id}
                                        onClick={() => handleNotificationClick(n)}
                                        className={clsx(
                                            "p-3 hover:bg-slate-50 cursor-pointer transition-colors relative group",
                                            !n.is_read && "bg-indigo-50/30"
                                        )}
                                    >
                                        {!n.is_read && (
                                            <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-indigo-500" />
                                        )}

                                        <div className="flex gap-3">
                                            <div className="flex-shrink-0 mt-1">
                                                <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                                                    {getIcon(n.type)}
                                                </div>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center justify-between mb-0.5">
                                                    <span className="text-sm font-bold text-slate-800 truncate">
                                                        {n.actor_name}
                                                    </span>
                                                    <span className="text-xs text-slate-400 flex-shrink-0 ml-2">
                                                        {formatDate(n.created_at)}
                                                    </span>
                                                </div>

                                                <p className="text-sm text-slate-600 line-clamp-2 mb-1">
                                                    {n.type === 'mention' && <span className="text-purple-600 font-medium mr-1">@提及了你</span>}
                                                    {n.type === 'reply' && <span className="text-blue-600 font-medium mr-1">回复了你</span>}
                                                    {n.type === 'comment' && <span className="text-slate-600 font-medium mr-1">评论了报告</span>}
                                                    {n.meta_data?.snippet || '无内容'}
                                                </p>

                                                {n.meta_data?.evaluation_title && (
                                                    <p className="text-xs text-slate-400 truncate flex items-center gap-1">
                                                        <ArrowRight className="w-3 h-3" />
                                                        {n.meta_data.evaluation_title}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
