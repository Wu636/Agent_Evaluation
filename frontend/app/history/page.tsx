"use client";

import { HistoryView } from "@/components/HistoryView";
import { useRouter } from "next/navigation";

export default function HistoryPage() {
    const router = useRouter();

    return (
        <div className="min-h-screen bg-white">
            <div className="w-full max-w-7xl mx-auto px-4 py-8">
                <HistoryView onBack={() => router.push('/')} />
            </div>
        </div>
    );
}
