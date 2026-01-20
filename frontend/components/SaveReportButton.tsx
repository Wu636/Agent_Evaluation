'use client';

import React, { useState } from 'react';
import { Bookmark } from 'lucide-react';
import { toast } from 'sonner';

interface SaveReportButtonProps {
    evaluationId: string;
    initialIsSaved?: boolean;
    onToggle?: (isSaved: boolean) => void;
    className?: string;
}

export function SaveReportButton({
    evaluationId,
    initialIsSaved = false,
    onToggle,
    className = ""
}: SaveReportButtonProps) {
    const [isSaved, setIsSaved] = useState(initialIsSaved);
    const [loading, setLoading] = useState(false);

    const handleToggle = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (loading) return;

        // Optimistic update
        const newState = !isSaved;
        setIsSaved(newState);
        setLoading(true);

        try {
            const res = await fetch('/api/evaluations/saved' + (newState ? '' : `?id=${evaluationId}`), {
                method: newState ? 'POST' : 'DELETE',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: newState ? JSON.stringify({ evaluationId }) : undefined
            });

            if (!res.ok) {
                throw new Error('操作失败');
            }

            toast.success(newState ? '已收藏' : '已取消收藏');
            if (onToggle) onToggle(newState);

        } catch (error) {
            // Revert on error
            setIsSaved(!newState);
            toast.error('操作失败，请重试');
            console.error('Save toggle error:', error);
        } finally {
            setLoading(false);
        }
    };

    return (
        <button
            onClick={handleToggle}
            disabled={loading}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${isSaved
                    ? 'text-yellow-600 bg-yellow-50 hover:bg-yellow-100'
                    : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                } ${className}`}
            title={isSaved ? "取消收藏" : "收藏报告"}
        >
            <Bookmark
                className={`w-4 h-4 ${isSaved ? 'fill-yellow-600' : ''}`}
            />
            <span className="text-sm font-medium">
                {isSaved ? '已收藏' : '收藏'}
            </span>
        </button>
    );
}
