'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from './AuthProvider';
import {
    MessageSquare, Send, Reply, Edit2, Trash2,
    MoreHorizontal, User, CornerDownRight, Loader2, X
} from 'lucide-react';
import { cn } from '@/lib/utils'; // Assuming cn utility exists, if not use clsx directly

interface Comment {
    id: string;
    content: string;
    user_id: string;
    user_name: string;
    user_email?: string;
    created_at: string;
    updated_at: string;
    is_edited: boolean;
    replies?: Comment[];
}

interface CommentSectionProps {
    evaluationId: string;
    isPublic: boolean;
}

export function CommentSection({ evaluationId, isPublic }: CommentSectionProps) {
    const { session, user } = useAuth();
    const [comments, setComments] = useState<Comment[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [newComment, setNewComment] = useState('');
    const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
    const [editingComment, setEditingComment] = useState<{ id: string; content: string } | null>(null);

    // Fetch comments
    useEffect(() => {
        fetchComments();
    }, [evaluationId]);

    const fetchComments = async () => {
        try {
            const res = await fetch(`/api/evaluations/${evaluationId}/comments`);
            if (res.ok) {
                const data = await res.json();
                setComments(data.comments || []);
            }
        } catch (err) {
            console.error('Failed to fetch comments', err);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newComment.trim() || !session?.access_token) return;

        setSubmitting(true);
        try {
            const res = await fetch(`/api/evaluations/${evaluationId}/comments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    content: newComment,
                    parent_comment_id: replyTo?.id
                })
            });

            if (res.ok) {
                setNewComment('');
                setReplyTo(null);
                fetchComments(); // Refresh list
            } else {
                const error = await res.json();
                alert(error.error || '发布评论失败');
            }
        } catch (err) {
            console.error('Failed to post comment', err);
            alert('发布评论失败');
        } finally {
            setSubmitting(false);
        }
    };

    const handleUpdate = async (commentId: string, content: string) => {
        if (!content.trim() || !session?.access_token) return;

        try {
            const res = await fetch(`/api/comments/${commentId}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({ content })
            });

            if (res.ok) {
                setEditingComment(null);
                fetchComments();
            } else {
                alert('更新评论失败');
            }
        } catch (err) {
            console.error('Failed to update comment', err);
        }
    };

    const handleDelete = async (commentId: string) => {
        if (!confirm('确定要删除这条评论吗？') || !session?.access_token) return;

        try {
            const res = await fetch(`/api/comments/${commentId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`
                }
            });

            if (res.ok) {
                fetchComments();
            } else {
                alert('删除评论失败');
            }
        } catch (err) {
            console.error('Failed to delete comment', err);
        }
    };

    const CommentItem = ({ comment, isReply = false }: { comment: Comment; isReply?: boolean }) => {
        const isOwner = user?.id === comment.user_id;
        const isEditing = editingComment?.id === comment.id;

        return (
            <div className={cn("flex gap-3", isReply && "ml-8 mt-3")}>
                <div className="flex-shrink-0">
                    <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-sm">
                        {comment.user_name.charAt(0).toUpperCase()}
                    </div>
                </div>
                <div className="flex-1 min-w-0">
                    <div className="bg-slate-50 rounded-2xl px-4 py-3 border border-slate-100">
                        <div className="flex items-center justify-between gap-2 mb-1">
                            <div className="flex items-center gap-2">
                                <span className="font-semibold text-slate-900 text-sm">
                                    {comment.user_name}
                                </span>
                                <span className="text-xs text-slate-400">
                                    {new Date(comment.created_at).toLocaleString()}
                                </span>
                                {comment.is_edited && (
                                    <span className="text-xs text-slate-400 italic">(已编辑)</span>
                                )}
                            </div>
                            {session && (
                                <div className="flex items-center gap-1">
                                    {!isEditing && !isReply && (
                                        <button
                                            onClick={() => setReplyTo({ id: comment.id, name: comment.user_name })}
                                            className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-indigo-600 transition-colors"
                                            title="回复"
                                        >
                                            <Reply className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                    {isOwner && !isEditing && (
                                        <>
                                            <button
                                                onClick={() => setEditingComment({ id: comment.id, content: comment.content })}
                                                className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-blue-600 transition-colors"
                                                title="编辑"
                                            >
                                                <Edit2 className="w-3.5 h-3.5" />
                                            </button>
                                            <button
                                                onClick={() => handleDelete(comment.id)}
                                                className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-red-600 transition-colors"
                                                title="删除"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>

                        {isEditing ? (
                            <div className="space-y-2 mt-2">
                                <textarea
                                    value={editingComment.content}
                                    onChange={(e) => setEditingComment({ ...editingComment, content: e.target.value })}
                                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                                    rows={3}
                                />
                                <div className="flex justify-end gap-2">
                                    <button
                                        onClick={() => setEditingComment(null)}
                                        className="px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200 rounded"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={() => handleUpdate(editingComment.id, editingComment.content)}
                                        className="px-3 py-1 text-xs font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700"
                                    >
                                        保存
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <p className="text-slate-700 text-sm whitespace-pre-wrap leading-relaxed">
                                {comment.content}
                            </p>
                        )}
                    </div>

                    {/* Replies */}
                    {comment.replies && comment.replies.length > 0 && (
                        <div className="space-y-3 mt-3">
                            {comment.replies.map(reply => (
                                <CommentItem key={reply.id} comment={reply} isReply={true} />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="w-full max-w-4xl mx-auto mt-12 mb-20 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                        <MessageSquare className="w-5 h-5 text-indigo-600" />
                        评论与讨论
                        <span className="text-xs font-light text-slate-400 ml-1">
                            ({loading ? '...' : comments.reduce((acc, c) => acc + 1 + (c.replies?.length || 0), 0)})
                        </span>
                    </h3>
                </div>

                <div className="p-6 bg-slate-50/50 min-h-[100px]">
                    {loading ? (
                        <div className="flex justify-center py-8">
                            <Loader2 className="w-8 h-8 text-slate-300 animate-spin" />
                        </div>
                    ) : comments.length === 0 ? (
                        <div className="text-center py-10 text-slate-400">
                            <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-20" />
                            <p>暂无评论，来发表第一条意见吧！</p>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {comments.map(comment => (
                                <CommentItem key={comment.id} comment={comment} />
                            ))}
                        </div>
                    )}
                </div>

                {/* Input Area */}
                <div className="p-6 bg-white border-t border-slate-100">
                    {session ? (
                        <form onSubmit={handleSubmit} className="space-y-4">
                            {replyTo && (
                                <div className="flex items-center justify-between bg-indigo-50 px-3 py-2 rounded-lg text-sm text-indigo-600 border border-indigo-100">
                                    <span className="flex items-center gap-1.5">
                                        <CornerDownRight className="w-4 h-4" />
                                        回复 <span className="font-semibold">@{replyTo.name}</span>
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setReplyTo(null)}
                                        className="p-0.5 hover:bg-indigo-100 rounded text-indigo-400"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            )}
                            <div className="flex gap-4">
                                <div className="flex-shrink-0 pt-1">
                                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold shadow-md">
                                        {user?.email?.charAt(0).toUpperCase() || 'U'}
                                    </div>
                                </div>
                                <div className="flex-1 relative">
                                    <textarea
                                        value={newComment}
                                        onChange={(e) => setNewComment(e.target.value)}
                                        placeholder={replyTo ? `回复 @${replyTo.name}...` : "写下您的建议或评论..."}
                                        className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all outline-none resize-none text-slate-700"
                                        rows={3}
                                        maxLength={2000}
                                    />
                                    <div className="absolute right-3 bottom-3 flex items-center gap-2">
                                        <span className="text-xs text-slate-400 pointer-events-none">
                                            {newComment.length}/2000
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex justify-end">
                                <button
                                    type="submit"
                                    disabled={submitting || !newComment.trim()}
                                    className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-xl font-medium shadow-lg shadow-indigo-200 hover:shadow-indigo-300 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                                >
                                    {submitting ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <Send className="w-4 h-4" />
                                    )}
                                    发送评论
                                </button>
                            </div>
                        </form>
                    ) : (
                        <div className="flex items-center justify-center py-6 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                            <p className="text-slate-500 text-sm">
                                请 <span className="font-semibold text-indigo-600">登录</span> 后参与讨论
                            </p>
                            {/* You could add a login button trigger here if accessible */}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// Simple clsx utility if needed, normally imported from lib/utils
// function cn(...inputs: (string | undefined | null | false)[]) {
//   return inputs.filter(Boolean).join(' ');
// }
