"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
    X,
    Settings,
    Save,
    Key,
    Globe,
    Cpu,
    Loader2,
    CheckCircle2,
    AlertCircle,
} from "lucide-react";
import { getModels, ModelInfo, testLlmConnectivity } from "@/lib/api";
import { AVAILABLE_MODELS } from "@/lib/config";
import {
    DEFAULT_LLM_API_URL,
    DEFAULT_IMAGE_MODEL,
    getRecommendedImageModel,
    getRecommendedModelForProfile,
    getRecommendedModelProfiles,
    LLM_SETTINGS_STORAGE_KEY,
    LLM_SETTINGS_UPDATED_EVENT,
    LLM_MODEL_PROFILE_OPTIONS,
    LLMModelProfileId,
    LLMModelProfiles,
    loadLLMSettingsFromStorage,
    persistLLMSettings,
} from "@/lib/llm/settings";

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const [apiKey, setApiKey] = useState("");
    const [apiUrl, setApiUrl] = useState(DEFAULT_LLM_API_URL);
    const [modelProfiles, setModelProfiles] = useState<LLMModelProfiles>(
        getRecommendedModelProfiles()
    );
    const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
    const [testProfileId, setTestProfileId] = useState<LLMModelProfileId>("default");
    const [models, setModels] = useState<ModelInfo[]>([]);
    const [imageModels, setImageModels] = useState<ModelInfo[]>([]);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{
        ok: boolean;
        message: string;
    } | null>(null);

    const loadSettingsFromStorage = () => {
        const settings = loadLLMSettingsFromStorage("default");
        setApiKey(settings.apiKey || "");
        setApiUrl(settings.apiUrl || DEFAULT_LLM_API_URL);
        setModelProfiles(settings.modelProfiles);
        setImageModel(settings.imageModel || DEFAULT_IMAGE_MODEL);
        return settings;
    };

    const refreshModels = async (nextApiUrl?: string, nextApiKey?: string) => {
        return getModels({
            baseUrl: nextApiUrl || "",
            apiKey: nextApiKey || "",
        })
            .then((data) => {
                setModels(data.models || []);
                const imageGroup = data.groups?.find((group) => group.key === "image");
                setImageModels(imageGroup?.models || []);
            })
            .catch((err) => console.error("Failed to fetch models:", err));
    };

    useEffect(() => {
        if (!isOpen) return;
        const settings = loadSettingsFromStorage();
        void refreshModels(settings.apiUrl, settings.apiKey);
        setTestResult(null);
    }, [isOpen]);

    useEffect(() => {
        const onUpdated = () => {
            const settings = loadSettingsFromStorage();
            if (isOpen) {
                void refreshModels(settings.apiUrl, settings.apiKey);
            }
        };
        const onStorage = (e: StorageEvent) => {
            if (e.key === LLM_SETTINGS_STORAGE_KEY) {
                const settings = loadSettingsFromStorage();
                if (isOpen) {
                    void refreshModels(settings.apiUrl, settings.apiKey);
                }
            }
        };
        window.addEventListener(LLM_SETTINGS_UPDATED_EVENT, onUpdated);
        window.addEventListener("storage", onStorage);
        return () => {
            window.removeEventListener(LLM_SETTINGS_UPDATED_EVENT, onUpdated);
            window.removeEventListener("storage", onStorage);
        };
    }, [isOpen]);

    const mergedModelOptions = useMemo(() => {
        const baseOptions = models.length > 0 ? models : AVAILABLE_MODELS;
        const optionIds = new Set(baseOptions.map((item) => item.id));
        const selectedIds = Array.from(
            new Set(Object.values(modelProfiles).filter(Boolean))
        );

        return [
            ...baseOptions,
            ...selectedIds
                .filter((id) => !optionIds.has(id))
                .map((id) => ({
                    id,
                    name: id,
                    description: "当前已保存模型",
                })),
        ];
    }, [models, modelProfiles]);

    const mergedImageModelOptions = useMemo(() => {
        const fallbackImageModels: ModelInfo[] = [
            {
                id: "doubao-seedream-5-0-260128",
                name: "豆包 Seedream 5.0",
                description: "推荐默认生图模型",
            },
            {
                id: "doubao-seedream-4-0-250828",
                name: "豆包 Seedream 4.0",
                description: "兼容的 Seedream 生图模型",
            },
            {
                id: "dall-e-3",
                name: "DALL-E 3",
                description: "OpenAI 图像生成模型",
            },
            {
                id: "gpt-image-1.5",
                name: "GPT Image 1.5",
                description: "OpenAI 图像生成模型",
            },
        ];
        const baseOptions = imageModels.length > 0 ? imageModels : fallbackImageModels;
        if (!imageModel || baseOptions.some((item) => item.id === imageModel)) {
            return baseOptions;
        }
        return [
            {
                id: imageModel,
                name: imageModel,
                description: "当前已保存图片模型",
            },
            ...baseOptions,
        ];
    }, [imageModel, imageModels]);

    const testTargetOptions = useMemo(() => {
        return LLM_MODEL_PROFILE_OPTIONS.map((profile) => {
            const selectedModel = modelProfiles[profile.id] || modelProfiles.default;
            const selectedOption = mergedModelOptions.find(
                (item) => item.id === selectedModel
            );

            return {
                id: profile.id,
                label: profile.label,
                modelId: selectedModel,
                modelName: selectedOption?.name || selectedModel,
            };
        });
    }, [mergedModelOptions, modelProfiles]);

    const handleModelProfileChange = (
        profileId: LLMModelProfileId,
        model: string
    ) => {
        setModelProfiles((prev) => ({
            ...prev,
            [profileId]: model,
        }));
        setTestResult(null);
    };

    const handleSave = () => {
        persistLLMSettings({
            apiKey,
            apiUrl,
            modelProfiles,
            imageModel,
        });
        onClose();
    };

    const handleTestConnectivity = async () => {
        setTesting(true);
        setTestResult(null);

        const targetProfile =
            LLM_MODEL_PROFILE_OPTIONS.find((item) => item.id === testProfileId) ||
            LLM_MODEL_PROFILE_OPTIONS[0];
        const targetModel =
            modelProfiles[testProfileId] || modelProfiles.default || "";

        try {
            const result = await testLlmConnectivity({
                apiKey,
                baseUrl: apiUrl,
                model: targetModel,
            });

            if (result.ok) {
                persistLLMSettings({
                    apiKey,
                    apiUrl,
                    modelProfiles,
                    imageModel,
                });
                const latency =
                    typeof result.latencyMs === "number"
                        ? `，耗时 ${result.latencyMs} ms`
                        : "";
                setTestResult({
                    ok: true,
                    message: `已测试“${targetProfile.label}”使用的模型 ${
                        result.model || targetModel
                    }。${result.message || "连接测试成功"}${latency}。当前设置已自动保存。`,
                });
            } else {
                setTestResult({
                    ok: false,
                    message: `测试“${targetProfile.label}”失败：${
                        result.error || "连接测试失败"
                    }`,
                });
            }
        } catch (error) {
            setTestResult({
                ok: false,
                message: `测试失败：${
                    error instanceof Error ? error.message : "连接测试失败"
                }`,
            });
        } finally {
            setTesting(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden animate-in zoom-in-95 duration-300 my-8">
                <div className="bg-gradient-to-r from-indigo-600 to-violet-600 p-6 flex items-center justify-between text-white">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                            <Settings className="w-6 h-6" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold">API Settings</h2>
                            <p className="text-indigo-100 text-sm">
                                Configure connectivity and model profiles
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2.5 hover:bg-red-500 rounded-xl transition-all bg-white/10 border-2 border-white hover:border-red-500"
                        title="Close"
                    >
                        <X className="w-6 h-6 stroke-[3] text-white" />
                    </button>
                </div>

                <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
                    <div>
                        <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
                            <Key className="w-4 h-4 text-indigo-600" />
                            API Key
                        </label>
                        <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => {
                                setApiKey(e.target.value);
                                setTestResult(null);
                            }}
                            placeholder="sk-..."
                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-base text-slate-900"
                        />
                        <p className="text-xs text-slate-400 mt-1.5">
                            Stored locally in your browser
                        </p>
                    </div>

                    <div>
                        <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
                            <Globe className="w-4 h-4 text-indigo-600" />
                            API URL
                        </label>
                        <input
                            type="text"
                            value={apiUrl}
                            onChange={(e) => {
                                setApiUrl(e.target.value);
                                setTestResult(null);
                            }}
                            placeholder="https://api.openai.com/v1/chat/completions"
                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-base text-slate-900"
                        />
                        <p className="text-xs text-slate-400 mt-1.5">
                            请填写当前网络可访问的完整 Chat Completions 地址
                        </p>
                    </div>

                    <div className="space-y-4">
                        <div className="flex items-center justify-between gap-3">
                            <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                                <Cpu className="w-4 h-4 text-indigo-600" />
                                场景模型配置
                            </label>
                            <button
                                type="button"
                                onClick={() => {
                                    setModelProfiles(getRecommendedModelProfiles());
                                    setImageModel(getRecommendedImageModel());
                                    setTestResult(null);
                                }}
                                className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                            >
                                恢复推荐配置
                            </button>
                        </div>
                        <div className="grid gap-3">
                            {LLM_MODEL_PROFILE_OPTIONS.map((profile) => {
                                const recommendedModel = getRecommendedModelForProfile(
                                    profile.id
                                );
                                const recommendedOption = mergedModelOptions.find(
                                    (item) => item.id === recommendedModel
                                );

                                return (
                                    <div
                                        key={profile.id}
                                        className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4"
                                    >
                                        <div className="flex items-start justify-between gap-3 mb-2">
                                            <div>
                                                <p className="text-sm font-bold text-slate-800">
                                                    {profile.label}
                                                </p>
                                                <p className="text-xs text-slate-500">
                                                    {profile.description}
                                                </p>
                                            </div>
                                            <span className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-slate-500 border border-slate-200 whitespace-nowrap">
                                                推荐{" "}
                                                {recommendedOption?.name ||
                                                    recommendedModel}
                                            </span>
                                        </div>
                                        <select
                                            value={modelProfiles[profile.id]}
                                            onChange={(e) =>
                                                handleModelProfileChange(
                                                    profile.id,
                                                    e.target.value
                                                )
                                            }
                                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all appearance-none bg-white cursor-pointer text-base text-slate-900"
                                        >
                                            {mergedModelOptions.map((model) => (
                                                <option
                                                    key={`${profile.id}-${model.id}`}
                                                    value={model.id}
                                                >
                                                    {model.name} -{" "}
                                                    {model.description}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                                    <Cpu className="w-4 h-4 text-indigo-600" />
                                    生图模型
                                </label>
                                <p className="text-xs text-slate-500 mt-1">
                                    用于训练注入封面图与背景图的默认图片模型
                                </p>
                            </div>
                            <span className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-slate-500 border border-slate-200 whitespace-nowrap">
                                推荐 {getRecommendedImageModel()}
                            </span>
                        </div>
                        <select
                            value={imageModel}
                            onChange={(e) => {
                                setImageModel(e.target.value);
                                setTestResult(null);
                            }}
                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all appearance-none bg-white cursor-pointer text-base text-slate-900"
                        >
                            {mergedImageModelOptions.map((model) => (
                                <option key={`image-${model.id}`} value={model.id}>
                                    {model.name} - {model.description}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-3">
                        <div className="space-y-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
                            <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                                <Globe className="w-4 h-4 text-indigo-600" />
                                连通性测试目标
                            </label>
                            <select
                                value={testProfileId}
                                onChange={(e) => {
                                    setTestProfileId(
                                        e.target.value as LLMModelProfileId
                                    );
                                    setTestResult(null);
                                }}
                                className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all appearance-none bg-white cursor-pointer text-base text-slate-900"
                            >
                                {testTargetOptions.map((item) => (
                                    <option key={`test-${item.id}`} value={item.id}>
                                        {item.label} - {item.modelName}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-slate-500">
                                当前只测试所选文生文模型的一次最小 Chat
                                Completions 请求，不会自动把所有模型都测一遍。生图模型连通性仍在训练注入流程里单独验证。
                            </p>
                        </div>

                        <button
                            onClick={handleTestConnectivity}
                            disabled={testing || !apiUrl.trim()}
                            className="w-full px-4 py-3 bg-white hover:bg-slate-50 border-2 border-slate-300 rounded-xl font-semibold text-slate-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            {testing ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Globe className="w-4 h-4" />
                            )}
                            {testing ? "测试中..." : "连通性测试"}
                        </button>

                        {testResult && (
                            <div
                                className={`flex items-start gap-2.5 p-3 rounded-xl border ${
                                    testResult.ok
                                        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                                        : "bg-rose-50 border-rose-200 text-rose-800"
                                }`}
                            >
                                {testResult.ok ? (
                                    <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                ) : (
                                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                )}
                                <p className="text-sm">{testResult.message}</p>
                            </div>
                        )}
                    </div>
                </div>

                <div className="px-6 py-5 bg-slate-50 border-t-2 border-slate-200 flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-6 py-3 text-slate-700 bg-white hover:bg-slate-100 border-2 border-slate-300 rounded-xl font-bold transition-all hover:border-slate-400 shadow-sm text-base"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        className="px-6 py-3 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-indigo-500/40 transition-all hover:shadow-xl hover:-translate-y-0.5 text-base"
                    >
                        <Save className="w-5 h-5" />
                        Save Settings
                    </button>
                </div>
            </div>
        </div>
    );
}
