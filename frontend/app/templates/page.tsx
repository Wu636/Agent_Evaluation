"use client";

import React, { useState, useEffect } from 'react';
import { TemplateEditor } from '@/components/TemplateEditor';
import { EvaluationTemplate } from '@/lib/templates';
import { Plus, Edit2, Trash2, Copy, Layout, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';

export default function TemplatesPage() {
    const [templates, setTemplates] = useState<EvaluationTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [isEditing, setIsEditing] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<EvaluationTemplate | undefined>(undefined);
    const router = useRouter();

    useEffect(() => {
        fetchTemplates();
    }, []);

    const fetchTemplates = async () => {
        try {
            const res = await fetch('/api/templates');
            const data = await res.json();
            if (data.templates) {
                setTemplates(data.templates);
            }
        } catch (error) {
            console.error('Failed to fetch templates:', error);
            toast.error('加载模板失败');
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = () => {
        setEditingTemplate(undefined);
        setIsEditing(true);
    };

    const handleEdit = (template: EvaluationTemplate) => {
        if (template.is_default && !template.user_id) {
            // 如果是系统模板，创建一个副本进行编辑
            const copy = { ...template, id: '', name: `${template.name} (副本)`, is_default: false };
            setEditingTemplate(copy as any); // ID为空表示新建
        } else {
            setEditingTemplate(template);
        }
        setIsEditing(true);
    };

    const handleDelete = async (id: string) => {
        if (!confirm('确定要删除这个模板吗？')) return;

        try {
            const res = await fetch(`/api/templates/${id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('删除失败');

            setTemplates(prev => prev.filter(t => t.id !== id));
            toast.success('模板已删除');
        } catch (error) {
            toast.error('删除模板失败');
        }
    };

    const handleSave = async (templateData: Partial<EvaluationTemplate>) => {
        try {
            const url = editingTemplate?.id
                ? `/api/templates/${editingTemplate.id}`
                : '/api/templates';

            const method = editingTemplate?.id ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(templateData)
            });

            if (!res.ok) throw new Error('保存失败');

            await fetchTemplates();
            setIsEditing(false);
        } catch (error) {
            throw error;
        }
    };

    if (isEditing) {
        return (
            <div className="min-h-screen bg-slate-50 p-8 flex items-center justify-center">
                <div className="w-full max-w-6xl">
                    <TemplateEditor
                        initialTemplate={editingTemplate}
                        onSave={handleSave}
                        onCancel={() => setIsEditing(false)}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-50">

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
                <div className="flex items-center justify-between mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-slate-900">评测模板库</h1>
                        <p className="mt-2 text-slate-500">管理您的自定义评测维度和评分标准</p>
                    </div>
                    <button
                        onClick={handleCreate}
                        className="px-6 py-3 bg-indigo-600 text-white font-bold rounded-xl shadow-lg hover:bg-indigo-700 hover:shadow-indigo-200 hover:-translate-y-0.5 transition-all flex items-center gap-2"
                    >
                        <Plus className="w-5 h-5" />
                        新建模板
                    </button>
                </div>

                {loading ? (
                    <div className="flex justify-center py-20">
                        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {templates.map(template => (
                            <div key={template.id} className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm hover:shadow-md transition-all group">
                                <div className="flex items-start justify-between mb-4">
                                    <div className="p-3 bg-indigo-50 rounded-xl text-indigo-600">
                                        <Layout className="w-6 h-6" />
                                    </div>
                                    {template.is_default && (
                                        <span className="px-2 py-1 bg-slate-100 text-slate-500 text-xs font-bold rounded-md">
                                            系统默认
                                        </span>
                                    )}
                                    {template.is_public && !template.is_default && (
                                        <span className="px-2 py-1 bg-green-50 text-green-600 text-xs font-bold rounded-md">
                                            公开
                                        </span>
                                    )}
                                </div>

                                <h3 className="text-lg font-bold text-slate-900 mb-2 group-hover:text-indigo-600 transition-colors">
                                    {template.name}
                                </h3>
                                <p className="text-sm text-slate-500 mb-6 line-clamp-2 h-10">
                                    {template.description || "暂无描述"}
                                </p>

                                <div className="flex items-center justify-between pt-4 border-t border-slate-50">
                                    <span className="text-xs text-slate-400">
                                        {new Date(template.updated_at).toLocaleDateString()}
                                    </span>

                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => handleEdit(template)}
                                            className="p-2 hover:bg-slate-50 rounded-lg text-slate-500 hover:text-indigo-600 transition-colors"
                                            title={template.is_default ? "复制并编辑" : "编辑"}
                                        >
                                            {template.is_default ? <Copy className="w-4 h-4" /> : <Edit2 className="w-4 h-4" />}
                                        </button>

                                        {!template.is_default && (
                                            <button
                                                onClick={() => handleDelete(template.id)}
                                                className="p-2 hover:bg-red-50 rounded-lg text-slate-400 hover:text-red-600 transition-colors"
                                                title="删除"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </main>
        </div>
    );
}
