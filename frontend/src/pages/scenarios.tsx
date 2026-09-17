import React, { useState, useEffect } from 'react'
import { runScenarioV1, ScenarioV1Response, post } from '../api'
import { Page, statusBadge, BeforeAfterReplanCard } from '../components'
import { useStore } from '../store'

/**
 * Scenarios & Stress Testing — Demonstration & Proof Screen.
 * Answers: "WHAT IF CONDITIONS CHANGE? (DEMONSTRATION & PROOF)"
 */
export const ScenariosPage: React.FC = () => {
  const { station, refresh } = useStore()
  const [selectedScenario, setSelectedScenario] = useState<string>('NORMAL')
  const [scenarioResult, setScenarioResult] = useState<ScenarioV1Response | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const scenariosList = [
    {
      id: 'NORMAL',
      label: '1. NORMAL OPERATIONS',
      badge: 'NOMINAL',
      badgeClass: 'safe',
      desc: 'Typical polar renewables, standard resupply envelope (+0.49 d CQRM). Plan is ACCEPTED.'
    },
    {
      id: 'STORM',
      label: '2. ANTARCTIC STORM',
      badge: 'WEATHER SEVERE',
      badgeClass: 'danger',
      desc: 'Severe gale drops wind to 45% & solar to 65%. Heating surges. Safe operability falls to 5.58 d. Plan REJECTED.'
    },
    {
      id: 'LOW_RENEWABLE',
      label: '3. LOW RENEWABLE PERIOD',
      badge: 'EXTENDED CALM',
      badgeClass: 'caution',
      desc: 'Prolonged calm and overcast. Operability drops to 6.12 d. CQRM turns to -4.18 d. Plan REJECTED.'
    },
    {
      id: 'RESUPPLY_DELAY_4D',
      label: '4. RESUPPLY DELAY (+4 DAYS)',
      badge: 'LOGISTICS STRESS',
      badgeClass: 'danger',
      desc: 'Convoy delayed 4 days. CQRM drops to -3.51 d (CRITICAL). Reserve requirement rises to 76.8% SOC.'
    },
    {
      id: 'BATTERY_DEGRADATION',
      label: '5. BATTERY DEGRADATION (75% SOH)',
      badge: 'HARDWARE WEAR',
      badgeClass: 'caution',
      desc: 'Usable capacity degraded to ~863 kWh. Optimizer compensates with scheduled generation.'
    },
    {
      id: 'COMMUNICATION_LOSS',
      label: '6. COMMUNICATION LOSS',
      badge: 'OFFLINE AUTONOMY',
      badgeClass: 'info',
      desc: 'Satellite link disconnected. All forecasting, optimization, and safety run locally.'
    }
  ]

  const executeScenario = async (id: string) => {
    setLoading(true)
    setError(null)
    setSelectedScenario(id)
    try {
      if (id === 'COMMUNICATION_LOSS') {
        await post('/connectivity/simulate-loss', {}).catch(() => {})
      } else if (id === 'NORMAL') {
        await post('/connectivity/restore', {}).catch(() => {})
      }
      const delay = id === 'RESUPPLY_DELAY_4D' ? 4.0 : 0.0
      const res = await runScenarioV1(id, delay)
      setScenarioResult(res)
      localStorage.setItem('polar_ems_active_scenario', id)
      localStorage.setItem('polar_ems_scenario_result', JSON.stringify(res))
      await refresh()
    } catch (err: any) {
      setError(err?.message || 'Failed to execute scenario')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem('polar_ems_active_scenario') || 'NORMAL'
    executeScenario(saved)
  }, [])

  const beforeAfter = station?.before_after_replan

  return (
    <Page
      title="Scenario Stress Testing & Proof"
      meta={scenarioResult && (
        <span className={`badge ${scenarioResult.final_decision === 'ACCEPT_PLAN' ? 'safe' : 'danger'}`}>
          {scenarioResult.final_decision} &bull; {scenarioResult.operating_mode}
        </span>
      )}
    >
      {/* 1. QUESTION HEADER */}
      <div className="card" style={{ borderLeft: '4px solid var(--blue)', marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--blue)', marginBottom: 4 }}>
          WHAT IF CONDITIONS CHANGE? (DEMONSTRATION & PROOF)
        </div>
        <p style={{ fontSize: 13, color: '#334155', margin: 0, lineHeight: 1.5 }}>
          Select an operational stress condition below to observe how the POLAR-EMS decision chain responds in real-time across forecast intervals, safe operability horizons, CQRM margins, and deterministic safety validation.
        </p>
      </div>

      {/* 2. SCENARIO SELECTOR */}
      <div className="grid g3" style={{ marginBottom: 14 }}>
        {scenariosList.map((sc) => (
          <div
            key={sc.id}
            className="card"
            style={{
              borderTop: selectedScenario === sc.id ? '4px solid var(--blue)' : '4px solid var(--border)',
              background: selectedScenario === sc.id ? 'rgba(56, 189, 248, 0.05)' : undefined,
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
            }}
            onClick={() => executeScenario(sc.id)}
          >
            <div>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <h4 style={{ margin: 0, fontSize: 12, fontWeight: 700 }}>{sc.label}</h4>
                <span className={`badge ${sc.badgeClass}`} style={{ fontSize: 10 }}>{sc.badge}</span>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>
                {sc.desc}
              </p>
            </div>
            <button
              type="button"
              className={selectedScenario === sc.id ? 'primary' : ''}
              disabled={loading}
              style={{ width: '100%', fontSize: 11, padding: '4px 8px', fontWeight: 600 }}
            >
              {selectedScenario === sc.id && loading ? 'Executing…' : selectedScenario === sc.id ? '✓ Active Scenario' : 'Run Scenario'}
            </button>
          </div>
        ))}
      </div>

      {error && (
        <div className="card" style={{ borderLeft: '4px solid var(--danger)', marginBottom: 14 }}>
          <b style={{ color: 'var(--danger)' }}>Scenario Notice:</b> {error}
        </div>
      )}

      {/* 3. BEFORE / AFTER REPLAN COMPARISON PROOF */}
      {beforeAfter && (
        <div className="section" style={{ marginBottom: 14 }}>
          <BeforeAfterReplanCard data={beforeAfter} />
        </div>
      )}

      {/* 4. SCENARIO OUTCOME KPIS */}
      {scenarioResult && (
        <div className="section card" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 }}>
            DECISION ENGINE OUTCOME: {scenarioResult.scenario}
          </div>

          <div className="grid g4" style={{ marginBottom: 14 }}>
            <div style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>SAFE OPERABILITY</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: scenarioResult.safe_operability_days < 7 ? 'var(--danger)' : 'var(--blue)', marginTop: 2 }}>
                {scenarioResult.safe_operability_days.toFixed(2)} <span style={{ fontSize: 12 }}>days</span>
              </div>
            </div>

            <div style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>CQRM RESUPPLY MARGIN</div>
              <div style={{
                fontSize: 24,
                fontWeight: 800,
                color: scenarioResult.cqrm_days < 0 ? 'var(--danger)' : 'var(--green)',
                marginTop: 2
              }}>
                {scenarioResult.cqrm_days > 0 ? `+${scenarioResult.cqrm_days.toFixed(2)}` : scenarioResult.cqrm_days.toFixed(2)} <span style={{ fontSize: 12 }}>days</span>
              </div>
            </div>

            <div style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>DYNAMIC RESERVE TARGET</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--purple)', marginTop: 2 }}>
                {scenarioResult.required_reserve_soc_pct.toFixed(1)}%
              </div>
            </div>

            <div style={{ background: scenarioResult.final_decision === 'ACCEPT_PLAN' ? '#f0fdf4' : '#fef2f2', padding: '10px 14px', borderRadius: 6, border: scenarioResult.final_decision === 'ACCEPT_PLAN' ? '1px solid #bbf7d0' : '1px solid #fecaca' }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>AUTHORITATIVE DECISION</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: scenarioResult.final_decision === 'ACCEPT_PLAN' ? 'var(--green)' : 'var(--danger)', marginTop: 2 }}>
                {scenarioResult.final_decision}
              </div>
            </div>
          </div>

          <div style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: 6, border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>
              Recommended Action: {scenarioResult.recommended_action}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
              <b>Rationale:</b> {scenarioResult.reason}
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
