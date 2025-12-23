import React, { useState, useEffect } from 'react';
import { X, Settings, Save, Key, Globe, Cpu } from 'lucide-react';
import clsx from 'clsx';

export function SettingsModal({ isOpen, onClose }) {
    const [apiKey, setApiKey] = useState('');
    const [apiUrl, setApiUrl] = useState('http://llm-service.polymas.com/api/openai/v1/chat/completions');
    const [model, setModel] = useState('gpt-4o');
    const [models, setModels] = useState([]);

    // Load settings from localStorage on mount
    useEffect(() => {
        const saved = localStorage.getItem('llm-eval-settings');
        if (saved) {
            const settings = JSON.parse(saved);
            setApiKey(settings.apiKey || '');
            setApiUrl(settings.apiUrl || 'http://llm-service.polymas.com/api/openai/v1/chat/completions');
            setModel(settings.model || 'gpt-4o');
        }

        // Fetch available models
        fetch('http://127.0.0.1:8001/api/models')
            .then(res => res.json())
            .then(data => setModels(data.models || []))
            .catch(err => console.error('Failed to fetch models:', err));
    }, []);

    const handleSave = () => {
        const settings = { apiKey, apiUrl, model };
        localStorage.setItem('llm-eval-settings', JSON.stringify(settings));
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in zoom-in-95 duration-300 my-8">

                {/* Header */}
                <div className="bg-gradient-to-r from-indigo-600 to-violet-600 p-6 flex items-center justify-between text-white">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                            <Settings className="w-6 h-6" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold">API Settings</h2>
                            <p className="text-indigo-100 text-sm">Configure evaluation parameters</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2.5 hover:bg-white/30 rounded-xl transition-all bg-white/20 border border-white/30"
                    >
                        <X className="w-6 h-6 stroke-[3]" />
                    </button>
                </div>

                {/* Form */}
                <div className="p-6 space-y-6 max-h-[60vh] overflow-y-auto">

                    {/* API Key */}
                    <div>
                        <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
                            <Key className="w-4 h-4 text-indigo-600" />
                            API Key
                        </label>
                        <input
                            type="password"
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            placeholder="sk-..."
                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-base"
                        />
                        <p className="text-xs text-slate-400 mt-1.5">Stored locally in your browser</p>
                    </div>

                    {/* API URL */}
                    <div>
                        <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
                            <Globe className="w-4 h-4 text-indigo-600" />
                            API URL
                        </label>
                        <input
                            type="text"
                            value={apiUrl}
                            onChange={(e) => setApiUrl(e.target.value)}
                            placeholder="https://api.openai.com/v1/chat/completions"
                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all text-base"
                        />
                    </div>

                    {/* Model Selection */}
                    <div>
                        <label className="flex items-center gap-2 text-sm font-bold text-slate-700 mb-2">
                            <Cpu className="w-4 h-4 text-indigo-600" />
                            Model
                        </label>
                        <select
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            className="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all appearance-none bg-white cursor-pointer text-base"
                        >
                            {models.length > 0 ? (
                                models.map(m => (
                                    <option key={m.id} value={m.id}>
                                        {m.name} - {m.description}
                                    </option>
                                ))
                            ) : (
                                <option value="gpt-4o">GPT-4o - Most capable</option>
                            )}
                        </select>
                    </div>

                </div>

                {/* Footer */}
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
