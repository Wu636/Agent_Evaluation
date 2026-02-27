'use client';

import React from 'react';
import { Sparkles, History, Settings, FileText, ClipboardCheck, Wand2, BookOpen, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { UserMenu } from './UserMenu';
import { SettingsModal } from './SettingsModal';
import { EnhancedLoginModal } from './EnhancedLoginModal';

export function Navbar() {
    const [showLoginModal, setShowLoginModal] = React.useState(false);
    const [showSettings, setShowSettings] = React.useState(false);

    return (
        <div className="bg-white border-b border-slate-100 sticky top-0 z-[100]">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
                <div className="flex items-center gap-8">
                    <Link href="/" className="flex items-center gap-2 group">
                        <div className="p-1.5 bg-indigo-50 rounded-lg group-hover:bg-indigo-100 transition-colors">
                            <Sparkles className="w-5 h-5 text-indigo-600" />
                        </div>
                        <span className="font-bold text-slate-800 text-lg">Agent Eval</span>
                    </Link>

                    <nav className="hidden md:flex items-center gap-1">
                        <button
                            onClick={() => { window.location.href = '/'; }}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-600 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors"
                        >
                            <Sparkles className="w-4 h-4" />
                            <span>评测</span>
                        </button>
                        <NavLink href="/homework-review" icon={<ClipboardCheck className="w-4 h-4" />}>作业批阅</NavLink>
                        <NavLink href="/training-generate" icon={<Wand2 className="w-4 h-4" />}>训练配置</NavLink>
                        <NavLink href="/explore" icon={<History className="w-4 h-4" />}>探索</NavLink>
                        <NavLink href="/history" icon={<History className="w-4 h-4" />}>历史记录</NavLink>
                        <button
                            onClick={() => setShowSettings(true)}
                            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-600 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors"
                        >
                            <Settings className="w-4 h-4" />
                            <span>设置</span>
                        </button>
                        <NavDropdown
                            label="模板库"
                            icon={<FileText className="w-4 h-4" />}
                            items={[
                                { href: '/templates', label: '评测模板库', icon: <FileText className="w-4 h-4" /> },
                                { href: '/prompt-templates', label: 'Prompt 模板', icon: <BookOpen className="w-4 h-4" /> },
                            ]}
                        />
                    </nav>
                </div>

                <div className="flex items-center gap-4">
                    <UserMenu onLoginClick={() => setShowLoginModal(true)} />
                </div>
            </div>

            <EnhancedLoginModal
                isOpen={showLoginModal}
                onClose={() => setShowLoginModal(false)}
            />

            <SettingsModal
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
            />
        </div>
    );
}

function NavLink({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <Link
            href={href}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-600 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors"
        >
            {icon}
            <span>{children}</span>
        </Link>
    );
}

interface DropdownItem {
    href: string;
    label: string;
    icon: React.ReactNode;
}

function NavDropdown({ label, icon, items }: { label: string; icon: React.ReactNode; items: DropdownItem[] }) {
    return (
        <div className="relative group">
            <button
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-600 hover:text-indigo-600 hover:bg-slate-50 rounded-lg transition-colors"
            >
                {icon}
                <span>{label}</span>
                <ChevronDown className="w-3 h-3 opacity-50 group-hover:opacity-100 transition-opacity" />
            </button>
            {/* Invisible bridge so mouse can move from button to dropdown */}
            <div className="absolute left-0 top-full w-full h-2 hidden group-hover:block" />
            <div className="absolute left-0 top-[calc(100%+0.5rem)] min-w-[180px] bg-white rounded-xl border border-slate-200 shadow-lg py-1.5 opacity-0 invisible group-hover:opacity-100 group-hover:visible translate-y-1 group-hover:translate-y-0 transition-all duration-150 z-50">
                {items.map((item) => (
                    <Link
                        key={item.href}
                        href={item.href}
                        className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-slate-600 hover:text-indigo-600 hover:bg-indigo-50/50 transition-colors"
                    >
                        {item.icon}
                        <span>{item.label}</span>
                    </Link>
                ))}
            </div>
        </div>
    );
}
