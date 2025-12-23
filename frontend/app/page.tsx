import { PortfolioNavbar } from "@/components/PortfolioNavbar"
import { EvaluationInterface } from "@/components/EvaluationInterface"
import { Footer } from "@/components/Footer"

export default function Page() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PortfolioNavbar />
      <main className="flex-1 pt-20">
        <EvaluationInterface />
      </main>
    </div>
  )
}
