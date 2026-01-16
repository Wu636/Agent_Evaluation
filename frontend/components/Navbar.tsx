'use client';

import React from 'react';
import { Sparkles, History, Settings, FileText } from 'lucide-react';
import Link from 'next/link';
import { UserMenu } from './UserMenu';
import { EnhancedLoginModal } from './EnhancedLoginModal';

export function Navbar() {
    const [showLoginModal, setShowLoginModal] = React.useState(false);

    return (
        <div className="bg-white border-b border-slate-100 sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
                <div className="flex items-center gap-8">
                    <Link href="/" className="flex items-center gap-2 group">
                        <div className="p-1.5 bg-indigo-50 rounded-lg group-hover:bg-indigo-100 transition-colors">
                            <Sparkles className="w-5 h-5 text-indigo-600" />
                        </div>
                        <span className="font-bold text-slate-800 text-lg">Agent Eval</span>
                    </Link>

                    <nav className="hidden md:flex items-center gap-1">
                        <NavLink href="/" icon={<Sparkles className="w-4 h-4" />}>评测</NavLink>
                        <NavLink href="/templates" icon={<FileText className="w-4 h-4" />}>模板库</NavLink>
                        <NavLink href="/explore" icon={<History className="w-4 h-4" />}>探索</NavLink>
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
