"use client"

import { useState } from "react"
import { PortfolioNavbar } from "@/components/PortfolioNavbar"
import { EvaluationInterface } from "@/components/EvaluationInterface"

export default function Page() {
  const [currentView, setCurrentView] = useState<'main' | 'history'>('main')

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PortfolioNavbar
        currentView={currentView}
        onNavigate={setCurrentView}
      />
      <main className="flex-1 pt-20">
        <EvaluationInterface
          currentView={currentView}
          onViewChange={setCurrentView}
        />
      </main>
    </div>
  )
}
