import React, { useEffect, useState } from 'react'
import { useStore } from './store'
import { statusBadge, SyntheticTopBadge } from './components'
import { post } from './api'

// Page components
import { OverviewPage } from './pages/overview'
import { LivePage } from './pages/live'
import { DataPage } from './pages/data'
import { ForecastPage } from './pages/forecast'
import { AutonomyPage } from './pages/autonomy'
import { OptimizationPage } from './pages/optimization'
import { SafetyPage } from './pages/safety'
import { ResupplyPage } from './pages/resupply'
import { ScenariosPage } from './pages/scenarios'
import { BaselinePage } from './pages/baseline'
import { AlertsPage } from './pages/alerts'
import { HistoryPage } from './pages/history'
import { SystemPage } from './pages/system'
import { SettingsPage } from './pages/settings'
import { SandboxPage } from './pages/sandbox'

const NAV_GROUPS = [
  {
    section: 'OPERATIONS',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'live', label: 'Live State' },
    ],
  },
  {
    section: 'DECISION',
    items: [
      { id: 'forecast', label: 'Forecast' },
      { id: 'autonomy', label: 'Safe Autonomy' },
      { id: 'optimization', label: 'Recommended Plan' },
      { id: 'scenarios', label: 'Scenarios' },
    ],
  },
  {
    section: 'EXPERIMENT',
    items: [
      { id: 'sandbox', label: 'Judge Sandbox' },
    ],
  },
  {
    section: 'CONTROL',
    items: [
      { id: 'resupply', label: 'Resupply' },
      { id: 'safety', label: 'Safety' },
    ],
  },
  {
    section: 'SYSTEM',
    items: [
      { id: 'data', label: 'Data & Diagnostics' },
      { id: 'history', label: 'History' },
      { id: 'system', label: 'System Health' },
      { id: 'settings', label: 'Settings' },
    ],
  },
] as const

export type PageId = typeof NAV_GROUPS[number]['items'][number]['id']

export const App: React.FC = () => {
  const { station, connected, refresh, simulationPaused, toggleClock } = useStore()

  // LocalStorage and URL hash persistence for page and state
  const [page, setPage] = useState<string>(() => {
    const hash = window.location.hash.replace('#', '')
    if (hash) return hash
    return localStorage.getItem('polar_ems_page') || 'overview'
  })

  useEffect(() => {
    localStorage.setItem('polar_ems_page', page)
    if (window.location.hash !== `#${page}`) {
      window.location.hash = page
    }
  }, [page])

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '')
      if (hash) setPage(hash)
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  // Collapsible groups state with localStorage persistence
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('polar_ems_nav_collapsed')
      const initial: Record<string, boolean> = saved ? JSON.parse(saved) : {}
      initial['OPERATIONS'] = false
      initial['DECISION'] = false
      initial['EXPERIMENT'] = false
      const curPage = localStorage.getItem('polar_ems_page') || 'overview'
      const activeGroup = NAV_GROUPS.find(g => g.items.some(item => item.id === curPage))
      if (activeGroup) {
        initial[activeGroup.section] = false
      }
      return initial
    } catch {
      return {}
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('polar_ems_nav_collapsed', JSON.stringify(collapsed))
    } catch {}
  }, [collapsed])

  // Keep/open the group containing the active page so it remains visible
  useEffect(() => {
    const activeGroup = NAV_GROUPS.find(g => g.items.some(item => item.id === page))
    if (activeGroup && collapsed[activeGroup.section]) {
      setCollapsed(prev => ({ ...prev, [activeGroup.section]: false }))
    }
  }, [page])

  const toggleGroup = (section: string) => {
    setCollapsed(prev => ({ ...prev, [section]: !prev[section] }))
  }

  // Restore delay state from localStorage on first mount if present
  useEffect(() => {
    const savedDelay = localStorage.getItem('polar_ems_resupply_delay')
    if (savedDelay) {
      const d = parseFloat(savedDelay)
      if (!isNaN(d) && d > 0) {
        post('/resupply/delay', { delay_days: d }).catch(() => {})
      }
    }
  }, [])

  const pages: Record<string, React.ReactNode> = {
    overview: <OverviewPage onNavigate={setPage} />,
    live: <LivePage />,
    data: <DataPage />,
    forecast: <ForecastPage />,
    autonomy: <AutonomyPage />,
    optimization: <OptimizationPage />,
    safety: <SafetyPage />,
    resupply: <ResupplyPage />,
    scenarios: <ScenariosPage />,
    baseline: <BaselinePage />,
    alerts: <AlertsPage />,
    history: <HistoryPage />,
    system: <SystemPage />,
    settings: <SettingsPage />,
    sandbox: <SandboxPage />,
  }

  const isOffline = station && station.connectivity.internet !== 'ONLINE'

  // Icon mapping for navigation
  const getNavIcon = (id: string) => {
    switch (id) {
      case 'overview':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
      case 'live':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
      case 'forecast':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" /></svg>
      case 'autonomy':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
      case 'optimization':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
      case 'scenarios':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
      case 'sandbox':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
      case 'resupply':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="1" y="3" width="15" height="13" /><polygon points="16 8 20 8 23 11 23 16 16 16 16 8" /><circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="18.5" r="2.5" /></svg>
      case 'safety':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
      case 'data':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /></svg>
      case 'history':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 8 14" /></svg>
      case 'system':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></svg>
      case 'settings':
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      default:
        return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /></svg>
    }
  }

  return (
    <>
      {/* 1. TOP GLOBAL DARK NAVY HEADER */}
      <header className="app-header">
        <div className="brand-area">
          <div className="brand-logo">
            <span className="logo-icon">P</span>
            <span>POLAR-EMS</span>
          </div>
          <span className="station-badge">
            ANTARCTIC STATION • DEMO
          </span>
        </div>

        <div className="center-status">
          <span className="status-tag">
            LOCAL DECISION PATH ACTIVE
          </span>
          <SyntheticTopBadge />
        </div>

        <div className="header-controls">
          <div className="control-item">
            <span style={{ fontSize: 11, color: '#94a3b8' }}>Resupply:</span>
            <b style={{ fontFamily: 'var(--mono)', color: '#f8fafc' }}>
              {station ? `${station.resupply.in_days.toFixed(1)} d` : '—'}
            </b>
            {station?.resupply?.delay_days ? (
              <span style={{ color: '#fb923c', fontSize: 11, marginLeft: 2 }}>
                (+{station.resupply.delay_days.toFixed(0)}d delay)
              </span>
            ) : null}
          </div>

          {/* Mode Badge */}
          {statusBadge(station ? station.mode : 'OFFLINE')}

          {/* Simulation Clock Indicator */}
          <button
            onClick={toggleClock}
            style={{
              background: simulationPaused ? 'rgba(251,191,36,0.18)' : 'rgba(34,197,94,0.18)',
              border: `1px solid ${simulationPaused ? 'var(--amber)' : 'var(--green)'}`,
              color: simulationPaused ? '#fcd34d' : '#86efac',
              borderRadius: 4, padding: '3px 9px', cursor: 'pointer',
              fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5,
            }}
            title={simulationPaused ? 'Click to resume simulation' : 'Click to pause simulation'}
          >
            {simulationPaused ? '⏸ PAUSED' : '▶ RUNNING'}
          </button>

          <span
            className="dot"
            style={{ background: connected ? 'var(--green)' : 'var(--red)' }}
            title={connected ? 'Loop active (3s)' : 'Offline'}
          />
        </div>
      </header>

      {/* 2. APP BODY: COMPACT ENTERPRISE SIDEBAR + LIGHT INDUSTRIAL WORKSPACE */}
      <div className="app-body-layout">
        <aside className="sidebar">
          {NAV_GROUPS.map(group => {
            const isCollapsed = !!collapsed[group.section]
            return (
              <div key={group.section} className="nav-group">
                <button
                  type="button"
                  className={`nav-section ${isCollapsed ? 'collapsed' : 'expanded'}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(group.section)}
                >
                  <span>{group.section}</span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="nav-chevron"
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                <div className={`nav-group-items ${isCollapsed ? 'collapsed' : 'expanded'}`}>
                  <div className="nav-group-items-inner">
                    {group.items.map(item => (
                      <a
                        key={item.id}
                        id={`nav-${item.id}`}
                        href={`#${item.id}`}
                        className={`nav-item ${page === item.id ? 'active' : ''}`}
                        onClick={(e) => {
                          e.preventDefault()
                          setPage(item.id)
                        }}
                      >
                        {getNavIcon(item.id)}
                        <span>{item.label}</span>
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </aside>

        <main className="main-content-area">
          {/* OFFLINE LOCAL MODE BANNER (Only when disconnected) */}
          {isOffline && (
            <div className="offline-banner" style={{ marginBottom: 14 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <b>EXTERNAL CONNECTIVITY LOST — LOCAL DECISION PATH ACTIVE</b>
                <span className="badge safe" style={{ background: '#fff', color: '#0f172a' }}>LOCAL DISPATCH ACTIVE</span>
              </div>
              <div className="offline-engines" style={{ marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11 }}>
                <span>DEMAND FORECAST: ACTIVE</span>
                <span>RENEWABLE FORECAST: ACTIVE</span>
                <span>SAFE OPERABILITY: ACTIVE</span>
                <span>OPTIMIZER: ACTIVE</span>
                <span>SAFETY VALIDATOR: ACTIVE</span>
              </div>
              <div className="note" style={{ marginTop: 4, fontSize: 11, color: '#334155' }}>
                Core local decision path continues without interruption during external communication loss.
              </div>
            </div>
          )}

          {/* Render Active Page */}
          {pages[page] ?? <OverviewPage onNavigate={setPage} />}
        </main>
      </div>
    </>
  )
}
