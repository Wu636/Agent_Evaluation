"use client"

import { useState, useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Menu, X } from "lucide-react"

interface PortfolioNavbarProps {
  currentView?: 'main' | 'history'
  onNavigate?: (view: 'main' | 'history') => void
}

const navigationLinks = [
  {
    name: "首页",
    view: "main" as const,
  },
  {
    name: "历史记录",
    view: "history" as const,
  }
]

// @component: PortfolioNavbar
export const PortfolioNavbar = ({ currentView = 'main', onNavigate }: PortfolioNavbarProps) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isScrolled, setIsScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20)
    }
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen)
  }

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false)
  }

  const handleLinkClick = (view: 'main' | 'history') => {
    closeMobileMenu()
    if (onNavigate) {
      onNavigate(view)
    }
    // Scroll to top when navigating
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
              onClick={() => handleLinkClick("main")}
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

          <div className="hidden md:block">
            <div className="ml-10 flex items-baseline space-x-8">
              {navigationLinks.map((link) => (
                <button
                  key={link.name}
                  onClick={() => handleLinkClick(link.view)}
                  className={`px-3 py-2 text-base font-medium transition-colors duration-200 relative group ${currentView === link.view
                      ? 'text-primary'
                      : 'text-foreground hover:text-primary'
                    }`}
                  style={{
                    fontFamily: "Figtree, sans-serif",
                    fontWeight: currentView === link.view ? "600" : "400",
                  }}
                >
                  <span>{link.name}</span>
                  <div className={`absolute bottom-0 left-0 h-0.5 bg-primary transition-all duration-300 ${currentView === link.view ? 'w-full' : 'w-0 group-hover:w-full'
                    }`}></div>
                </button>
              ))}
            </div>
          </div>

          <div className="hidden md:block">
            {/* CTA Removed */}
          </div>

          <div className="md:hidden">
            <button
              onClick={toggleMobileMenu}
              className="text-foreground hover:text-primary p-2 rounded-md transition-colors duration-200"
              aria-label="Toggle mobile menu"
            >
              {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{
              opacity: 0,
              height: 0,
            }}
            animate={{
              opacity: 1,
              height: "auto",
            }}
            exit={{
              opacity: 0,
              height: 0,
            }}
            transition={{
              duration: 0.3,
              ease: "easeInOut",
            }}
            className="md:hidden bg-background/95 backdrop-blur-md border-t border-border"
          >
            <div className="px-6 py-6 space-y-4">
              {navigationLinks.map((link) => (
                <button
                  key={link.name}
                  onClick={() => handleLinkClick(link.view)}
                  className={`block w-full text-left py-3 text-lg font-medium transition-colors duration-200 ${currentView === link.view
                      ? 'text-primary'
                      : 'text-foreground hover:text-primary'
                    }`}
                  style={{
                    fontFamily: "Figtree, sans-serif",
                    fontWeight: currentView === link.view ? "600" : "400",
                  }}
                >
                  <span>{link.name}</span>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav >
  )
}
