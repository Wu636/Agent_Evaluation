"use client"

import { useState, useEffect } from "react"

interface PortfolioNavbarProps {
  currentView?: 'main' | 'history'
  onNavigate?: (view: 'main' | 'history') => void
}

// @component: PortfolioNavbar
export const PortfolioNavbar = ({ currentView = 'main', onNavigate }: PortfolioNavbarProps) => {
  const [isScrolled, setIsScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20)
    }
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  const handleLogoClick = () => {
    if (onNavigate) {
      onNavigate('main')
    }
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // @return
  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${isScrolled ? "bg-background/95 backdrop-blur-md shadow-sm" : "bg-transparent"}`}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="flex items-center justify-between h-20">
          <div className="flex-shrink-0">
            <button
              onClick={handleLogoClick}
              className="text-2xl font-bold text-foreground hover:text-primary transition-colors duration-200"
              style={{
                fontFamily: "Plus Jakarta Sans, sans-serif",
              }}
            >
              <span
                style={{
                  fontFamily: "Figtree",
                  fontWeight: "800",
                }}
              >
                智能体评测 AgentEval
              </span>
            </button>
          </div>
        </div>
      </div>
    </nav>
  )
}
