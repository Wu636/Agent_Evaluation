"use client"


import { EvaluationInterface } from "@/components/EvaluationInterface"

export default function Page() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <main className="flex-1">
        <EvaluationInterface />
      </main>
    </div>
  )
}
