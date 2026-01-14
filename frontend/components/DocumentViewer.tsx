import React, { useState } from 'react';
import { X, Copy, Check, FileText } from 'lucide-react';

interface DocumentViewerProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    content: string;
    type?: 'markdown' | 'json' | 'text';
}

export function DocumentViewer({ isOpen, onClose, title, content, type = 'text' }: DocumentViewerProps) {
    const [copied, setCopied] = useState(false);

    if (!isOpen) return null;

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(content);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy text:', err);
        }
    };

    // 简单的 JSON 格式化
    const formattedContent = type === 'json' ? (() => {
        try {
            // 如果已经是对象，直接 stringify
            if (typeof content === 'object') return JSON.stringify(content, null, 2);
            // 如果是字符串，尝试解析再 stringify 以美化
            return JSON.stringify(JSON.parse(content), null, 2);
        } catch {
            return content;
        }
    })() : content;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-4xl h-[85vh] flex flex-col animate-in fade-in zoom-in duration-200">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-50 rounded-lg text-indigo-600">
                            <FileText className="w-5 h-5" />
                        </div>
                        <h3 className="text-lg font-bold text-slate-800">{title}</h3>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors"
                        >
                            {copied ? (
                                <>
                                    <Check className="w-4 h-4" />
                                    <span>已复制</span>
                                </>
                            ) : (
                                <>
                                    <Copy className="w-4 h-4" />
                                    <span>复制内容</span>
                                </>
                            )}
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
                    <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm min-h-full">
                        <pre className="whitespace-pre-wrap font-mono text-sm text-slate-700 leading-relaxed">
                            {formattedContent}
                        </pre>
                    </div>
                </div>
            </div>
        </div>
    );
}
