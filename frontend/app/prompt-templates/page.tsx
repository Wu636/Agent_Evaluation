"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
    Search,
    Globe,
    Lock,
    Star,
    Loader2,
    Plus,
    Trash2,
    Edit3,
    Copy,
    Wand2,
    BookOpen,
    ClipboardList,
    Filter,
    ArrowUpDown,
    Eye,
    Tag,
    Users,
} from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { PromptTemplate, PromptTemplateType } from "@/lib/training-generator/types";

type SortField = "updated_at" | "use_count" | "name";
type FilterType = "all" | "script" | "rubric";
type FilterScope = "all" | "mine" | "public" | "default";

export default function PromptTemplatesPage() {
    const [templates, setTemplates] = useState<PromptTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [filterType, setFilterType] = useState<FilterType>("all");
    const [filterScope, setFilterScope] = useState<FilterScope>("all");
    const [sortField, setSortField] = useState<SortField>("updated_at");
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const router = useRouter();

    const fetchTemplates = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (filterType !== "all") params.set("type", filterType);
            const res = await fetch(`/api/prompt-templates?${params}`);
            const data = await res.json();
            if (data.templates) {
                setTemplates(data.templates);
            }
        } catch {
            toast.error("加载模板失败");
        } finally {
            setLoading(false);
        }
    }, [filterType]);

    useEffect(() => {
        fetchTemplates();
    }, [fetchTemplates]);

    // 过滤与搜索
    const filtered = templates
        .filter((t) => {
            if (filterScope === "mine") return t.user_id && !t.is_default;
            if (filterScope === "public") return t.is_public;
            if (filterScope === "default") return t.is_default;
            return true;
        })
        .filter((t) => {
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return (
                t.name.toLowerCase().includes(q) ||
                (t.description || "").toLowerCase().includes(q) ||
                t.tags.some((tag) => tag.toLowerCase().includes(q))
            );
        })
        .sort((a, b) => {
            if (sortField === "use_count") return b.use_count - a.use_count;
            if (sortField === "name") return a.name.localeCompare(b.name);
            return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        });

    const handleDelete = async (id: string) => {
        if (!confirm("确定删除此模板？此操作不可撤销。")) return;
        try {
            const res = await fetch(`/api/prompt-templates/${id}`, { method: "DELETE" });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "删除失败");
            }
            setTemplates((prev) => prev.filter((t) => t.id !== id));
            toast.success("模板已删除");
        } catch (err: any) {
            toast.error(err.message || "删除模板失败");
        }
    };

    const handleDuplicate = async (t: PromptTemplate) => {
        try {
            const res = await fetch("/api/prompt-templates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: `${t.name} (副本)`,
                    description: t.description,
                    type: t.type,
                    prompt_template: t.prompt_template,
                    system_prompt: t.system_prompt,
                    is_public: false,
                    tags: t.tags,
                }),
            });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "复制失败");
            }
            toast.success("已复制为私有模板");
            fetchTemplates();
        } catch (err: any) {
            toast.error(err.message || "复制失败");
        }
    };

    const handleUse = (t: PromptTemplate) => {
        // 将模板信息存到 sessionStorage，跳转到生成页自动加载
        sessionStorage.setItem(
            "use-prompt-template",
            JSON.stringify({ id: t.id, type: t.type })
        );
        router.push("/training-generate");
    };

    const typeLabel = (type: PromptTemplateType) =>
        type === "script" ? "剧本配置" : "评分标准";

    const typeColor = (type: PromptTemplateType) =>
        type === "script"
            ? "bg-violet-100 text-violet-700"
            : "bg-amber-100 text-amber-700";

    const scopeCounts = {
        all: templates.length,
        mine: templates.filter((t) => t.user_id && !t.is_default).length,
        public: templates.filter((t) => t.is_public).length,
        default: templates.filter((t) => t.is_default).length,
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50/30">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* Header */}
                <div className="mb-8">
                    <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
                        Prompt 模板市场
                    </h1>
                    <p className="text-slate-500 mt-2">
                        浏览和管理训练配置与评分标准的 Prompt 模板，使用社区共享的模板或创建自己的专属模板
                    </p>
                </div>

                {/* Filters & Search */}
                <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 mb-6 space-y-4">
                    {/* Search bar */}
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="搜索模板名称、描述或标签..."
                            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-300"
                        />
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        {/* Scope tabs */}
                        <div className="flex items-center gap-1 bg-slate-50 rounded-lg p-1">
                            {(
                                [
                                    ["all", "全部", null],
                                    ["mine", "我的", Users],
                                    ["public", "公开", Globe],
                                    ["default", "系统", Star],
                                ] as const
                            ).map(([value, label, Icon]) => (
                                <button
                                    key={value}
                                    onClick={() => setFilterScope(value)}
                                    className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                                        filterScope === value
                                            ? "bg-white shadow-sm text-indigo-600"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    {Icon && <Icon className="w-3 h-3" />}
                                    {label}
                                    <span className="text-[10px] opacity-60">({scopeCounts[value]})</span>
                                </button>
                            ))}
                        </div>

                        {/* Type filter */}
                        <div className="flex items-center gap-1 bg-slate-50 rounded-lg p-1">
                            <Filter className="w-3.5 h-3.5 text-slate-400 ml-2" />
                            {(
                                [
                                    ["all", "全部类型"],
                                    ["script", "剧本配置"],
                                    ["rubric", "评分标准"],
                                ] as const
                            ).map(([value, label]) => (
                                <button
                                    key={value}
                                    onClick={() => setFilterType(value)}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                                        filterType === value
                                            ? "bg-white shadow-sm text-indigo-600"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {/* Sort */}
                        <div className="flex items-center gap-1 ml-auto">
                            <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                            <select
                                value={sortField}
                                onChange={(e) => setSortField(e.target.value as SortField)}
                                className="text-xs text-slate-600 bg-transparent border-none focus:outline-none cursor-pointer"
                            >
                                <option value="updated_at">最近更新</option>
                                <option value="use_count">使用次数</option>
                                <option value="name">名称排序</option>
                            </select>
                        </div>
                    </div>
                </div>

                {/* Template Grid */}
                {loading ? (
                    <div className="flex items-center justify-center py-20">
                        <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
                        <span className="ml-2 text-slate-500 text-sm">加载模板中...</span>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-20 text-slate-400">
                        <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-40" />
                        <p className="text-sm">没有找到匹配的模板</p>
                        {search && (
                            <button
                                onClick={() => setSearch("")}
                                className="mt-2 text-xs text-indigo-500 hover:underline"
                            >
                                清除搜索
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {filtered.map((t) => (
                            <div
                                key={t.id}
                                className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden group"
                            >
                                {/* Card Header */}
                                <div className="p-4 pb-3">
                                    <div className="flex items-start justify-between gap-2 mb-2">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full ${typeColor(t.type)}`}>
                                                {t.type === "script" ? (
                                                    <BookOpen className="w-3 h-3 inline mr-0.5 -mt-0.5" />
                                                ) : (
                                                    <ClipboardList className="w-3 h-3 inline mr-0.5 -mt-0.5" />
                                                )}
                                                {typeLabel(t.type)}
                                            </span>
                                            {t.is_default && (
                                                <span className="px-2 py-0.5 text-[10px] font-semibold bg-emerald-100 text-emerald-700 rounded-full flex items-center gap-0.5">
                                                    <Star className="w-3 h-3" />
                                                    系统
                                                </span>
                                            )}
                                            {t.is_public && !t.is_default && (
                                                <Globe className="w-3.5 h-3.5 text-emerald-500" />
                                            )}
                                            {!t.is_public && !t.is_default && (
                                                <Lock className="w-3.5 h-3.5 text-slate-400" />
                                            )}
                                        </div>
                                        <span className="text-[10px] text-slate-400 whitespace-nowrap flex items-center gap-1">
                                            🔥 {t.use_count}
                                        </span>
                                    </div>

                                    <h3 className="font-semibold text-sm text-slate-800 line-clamp-1 mb-1">
                                        {t.name}
                                    </h3>
                                    {t.description && (
                                        <p className="text-xs text-slate-500 line-clamp-2 mb-2">
                                            {t.description}
                                        </p>
                                    )}

                                    {/* Tags */}
                                    {t.tags.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mb-2">
                                            {t.tags.slice(0, 4).map((tag) => (
                                                <span
                                                    key={tag}
                                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-slate-50 text-slate-500 text-[10px] rounded-md"
                                                >
                                                    <Tag className="w-2.5 h-2.5" />
                                                    {tag}
                                                </span>
                                            ))}
                                            {t.tags.length > 4 && (
                                                <span className="text-[10px] text-slate-400">+{t.tags.length - 4}</span>
                                            )}
                                        </div>
                                    )}

                                    <div className="flex items-center justify-between">
                                        <p className="text-[10px] text-slate-400">
                                            更新于 {new Date(t.updated_at).toLocaleDateString("zh-CN")}
                                        </p>
                                        {t.creator_name && (
                                            <span className="text-[10px] text-slate-400 flex items-center gap-1">
                                                <Users className="w-3 h-3" />
                                                {t.creator_name}
                                            </span>
                                        )}
                                        {t.is_default && !t.creator_name && (
                                            <span className="text-[10px] text-slate-400 flex items-center gap-1">
                                                <Star className="w-3 h-3" />
                                                系统内置
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Card Actions */}
                                <div className="border-t border-slate-100 p-3 flex items-center gap-2">
                                    <button
                                        onClick={() => handleUse(t)}
                                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
                                    >
                                        <Wand2 className="w-3.5 h-3.5" />
                                        使用此模板
                                    </button>
                                    <button
                                        onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                                        className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
                                        title="预览 Prompt"
                                    >
                                        <Eye className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => handleDuplicate(t)}
                                        className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                                        title="复制为我的模板"
                                    >
                                        <Copy className="w-4 h-4" />
                                    </button>
                                    {!t.is_default && t.user_id && (
                                        <button
                                            onClick={() => handleDelete(t.id)}
                                            className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                            title="删除"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>

                                {/* Expanded Preview */}
                                {expandedId === t.id && (
                                    <div className="border-t border-slate-100 p-4">
                                        <p className="text-xs font-medium text-slate-600 mb-2">Prompt 预览:</p>
                                        <pre className="p-3 bg-slate-50 rounded-lg text-[11px] text-slate-600 font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">
                                            {t.prompt_template}
                                        </pre>
                                        {t.system_prompt && (
                                            <>
                                                <p className="text-xs font-medium text-slate-600 mt-3 mb-2">System Prompt:</p>
                                                <pre className="p-3 bg-slate-50 rounded-lg text-[11px] text-slate-600 font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
                                                    {t.system_prompt}
                                                </pre>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
