"use client"

import { useState } from "react"
import { EvaluationInterface } from "@/components/EvaluationInterface"

export default function Page() {
  const [currentView, setCurrentView] = useState<'main' | 'history'>('main')

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <main className="flex-1">
        <EvaluationInterface
          currentView={currentView}
          onViewChange={setCurrentView}
        />
      </main>
    </div>
  )
}
