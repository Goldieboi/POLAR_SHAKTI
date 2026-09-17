import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useStore } from '../store'
import {
  SandboxExperimentRequest,
  SandboxExperimentResponse,
  CandidatePlan,
  ExecutionTraceStep,
  runSandboxExperiment,
  applySandboxExperiment,
  selectCandidatePlan,
  resetSandboxToBaseline,
} from '../api'

// ---------------------------------------------------------------- Types ----
interface SliderConfig {
  key: string
  label: string
  min: number
  max: number
  step: number
  unit: string
  group: string
}

const SLIDERS: SliderConfig[] = [
  // Battery
  { key: 'battery_soc', label: 'Battery SOC', min: 0, max: 100, step: 1, unit: '%', group: 'Battery' },
  { key: 'battery_soh', label: 'Battery SOH', min: 50, max: 100, step: 1, unit: '%', group: 'Battery' },
  // Renewables
  { key: 'solar_kw', label: 'Solar Generation', min: 0, max: 120, step: 1, unit: 'kW', group: 'Renewables' },
  { key: 'wind_kw', label: 'Wind Generation', min: 0, max: 150, step: 1, unit: 'kW', group: 'Renewables' },
  // Demand
  { key: 'station_load_kw', label: 'Station Load', min: 50, max: 350, step: 5, unit: 'kW', group: 'Demand' },
  { key: 'critical_load_kw', label: 'Critical Load', min: 20, max: 150, step: 1, unit: 'kW', group: 'Demand' },
  { key: 'flexible_load_kw', label: 'Flexible Load', min: 0, max: 100, step: 1, unit: 'kW', group: 'Demand' },
  // Generator / Fuel
  { key: 'fuel_l', label: 'Fuel Level', min: 0, max: 10000, step: 50, unit: 'L', group: 'Generator / Fuel' },
  // Logistics
  { key: 'resupply_delay_days', label: 'Resupply Delay', min: 0, max: 7, step: 0.5, unit: 'days', group: 'Logistics' },
  // Temperature
  { key: 'temperature_c', label: 'Temperature', min: -50, max: 10, step: 1, unit: '\u00B0C', group: 'Demand' },
]

const PRESETS: { label: string; values: Partial<SandboxExperimentRequest> }[] = [
  { label: 'Blizzard Storm', values: { solar_kw: 5, wind_kw: 10, temperature_c: -38, resupply_delay_days: 3, communication_loss: true } },
  { label: 'Low Renewable', values: { solar_kw: 8, wind_kw: 15 } },
  { label: 'Resupply Delay +4d', values: { resupply_delay_days: 4 } },
  { label: 'Battery Degradation', values: { battery_soc: 35, battery_soh: 72 } },
  { label: 'Communication Loss', values: { communication_loss: true } },
]

// ---------------------------------------------------------------- Helpers ----
function deltaArrow(base: number, exp: number): string {
  if (exp > base + 0.01) return '\u2191'
  if (exp < base - 0.01) return '\u2193'
  return '\u2192'
}

function deltaColor(base: number, exp: number, higherIsBetter: boolean): string {
  const diff = exp - base
  if (Math.abs(diff) < 0.01) return 'var(--text-dim)'
  if (higherIsBetter) return diff > 0 ? 'var(--green)' : 'var(--red)'
  return diff < 0 ? 'var(--green)' : 'var(--red)'
}

// ---------------------------------------------------------------- Component ----
export const SandboxPage: React.FC = () => {
  const { station, refresh } = useStore()

  // Session
  const [sessionId, setSessionId] = useState<string | null>(null)

  // Slider local values (for debounce)
  const [localValues, setLocalValues] = useState<Record<string, number>>({})
  const [toggles, setToggles] = useState<{
    generator_available: boolean
    communication_loss: boolean
  }>({ generator_available: true, communication_loss: false })

  // Experiment result
  const [result, setResult] = useState<SandboxExperimentResponse | null>(null)
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null)
  const [showTechnicalDetails, setShowTechnicalDetails] = useState<string | null>(null)

  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applySuccess, setApplySuccess] = useState<string | null>(null)

  // Debounce timer
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Initialize slider values from station & auto-run initial experiment on mount
  useEffect(() => {
    if (!station) return
    const initial: Record<string, number> = {
      battery_soc: station.battery_soc,
      battery_soh: station.battery_soh,
      solar_kw: station.balance?.solar_kw ?? 40,
      wind_kw: station.balance?.wind_kw ?? 30,
      station_load_kw: station.loads.total_kw,
      critical_load_kw: station.loads.critical_kw,
      flexible_load_kw: station.loads.flexible_kw,
      fuel_l: station.fuel_l,
      resupply_delay_days: station.resupply?.delay_days ?? 0,
      temperature_c: station.weather.temperature_c,
    }
    setLocalValues(initial)
    const initToggles = {
      generator_available: !station.generator_failed,
      communication_loss: station.connectivity.internet !== 'ONLINE',
    }
    setToggles(initToggles)

    // Automatically trigger initial experiment on mount so candidate plans and table are immediately visible
    if (!result) {
      triggerExperiment(initial, initToggles)
    }
  }, [station?.battery_soc])

  // ---- Debounced auto-recalculation ----
  const triggerExperiment = useCallback(async (overrideVals?: Record<string, number>, overrideToggles?: typeof toggles) => {
    const vals = overrideVals || localValues
    const togs = overrideToggles || toggles

    const req: SandboxExperimentRequest = {
      sandbox_session_id: sessionId || undefined,
      battery_soc: vals.battery_soc,
      battery_soh: vals.battery_soh,
      solar_kw: vals.solar_kw,
      wind_kw: vals.wind_kw,
      station_load_kw: vals.station_load_kw,
      critical_load_kw: vals.critical_load_kw,
      flexible_load_kw: vals.flexible_load_kw,
      fuel_l: vals.fuel_l,
      resupply_delay_days: vals.resupply_delay_days,
      temperature_c: vals.temperature_c,
      generator_available: togs.generator_available,
      communication_loss: togs.communication_loss,
    }

    setLoading(true)
    setError(null)
    setApplySuccess(null)
    try {
      const res = await runSandboxExperiment(req)
      setResult(res)
      setSessionId(res.sandbox_session_id)

      // Set selected plan: maintain current selection if feasible, else default to recommended or first feasible
      if (res.candidate_plans && res.candidate_plans.length > 0) {
        const currentFeasible = res.candidate_plans.find(p => p.id === selectedPlanId && p.safety_passed)
        if (currentFeasible) {
          setSelectedPlanId(currentFeasible.id)
        } else if (res.recommended_plan_id) {
          setSelectedPlanId(res.recommended_plan_id)
        } else {
          const firstFeasible = res.candidate_plans.find(p => p.safety_passed)
          setSelectedPlanId(firstFeasible ? firstFeasible.id : null)
        }
      }
    } catch (e: any) {
      setError(e.message || 'Experiment failed')
    } finally {
      setLoading(false)
    }
  }, [localValues, toggles, sessionId, selectedPlanId])

  const handleSliderChange = (key: string, value: number) => {
    setLocalValues(prev => {
      const next = { ...prev, [key]: value }
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => triggerExperiment(next), 350)
      return next
    })
  }

  const handleToggle = (key: 'generator_available' | 'communication_loss') => {
    setToggles(prev => {
      const next = { ...prev, [key]: !prev[key] }
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => triggerExperiment(undefined, next), 350)
      return next
    })
  }

  const handlePreset = (preset: typeof PRESETS[number]) => {
    const newVals = { ...localValues }
    const newToggles = { ...toggles }

    for (const [k, v] of Object.entries(preset.values)) {
      if (k === 'generator_available') newToggles.generator_available = v as boolean
      else if (k === 'communication_loss') newToggles.communication_loss = v as boolean
      else newVals[k] = v as number
    }

    setLocalValues(newVals)
    setToggles(newToggles)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => triggerExperiment(newVals, newToggles), 200)
  }

  const handleSelectPlan = async (plan: CandidatePlan) => {
    if (!plan.safety_passed) return
    setSelectedPlanId(plan.id)
    if (sessionId) {
      try {
        await selectCandidatePlan(sessionId, plan.id)
      } catch (e) {
        console.error('Plan selection sync failed', e)
      }
    }
  }

  const handleApply = async () => {
    if (!result || !sessionId) return
    const planToApply = allAvailablePlans.find(p => p.id === selectedPlanId)
    if (planToApply && !planToApply.safety_passed && planToApply.strategy_type !== 'EMERGENCY_CONSERVATION') {
      setError('Cannot apply an unsafe plan. Please select a feasible plan or Emergency Conservation recovery.')
      return
    }

    setApplying(true)
    setError(null)
    setApplySuccess(null)
    try {
      const res = await applySandboxExperiment(sessionId, result.state_version, selectedPlanId || undefined)
      await refresh()
      setApplySuccess(`Plan "${res.applied_plan?.name || 'Selected Plan'}" applied to global simulation!`)
    } catch (e: any) {
      if (e.message?.includes('409') || e.message?.includes('STATE_CHANGED')) {
        setError('State has changed since your experiment. Please re-run the experiment before applying.')
      } else {
        setError(e.message || 'Apply failed')
      }
    } finally {
      setApplying(false)
    }
  }

  const handleReset = async () => {
    setError(null)
    setApplySuccess(null)
    try {
      await resetSandboxToBaseline(sessionId || undefined)
      setResult(null)
      setSessionId(null)
      setSelectedPlanId(null)
      await refresh()
      setTimeout(() => {
        if (station) {
          setLocalValues({
            battery_soc: 62, battery_soh: 94, solar_kw: 40, wind_kw: 30,
            station_load_kw: 182, critical_load_kw: 72, flexible_load_kw: 50,
            fuel_l: 8420, resupply_delay_days: 0, temperature_c: -18,
          })
          setToggles({ generator_available: true, communication_loss: false })
        }
      }, 300)
    } catch (e: any) {
      setError(e.message || 'Reset failed')
    }
  }

  // Group sliders
  const groups: Record<string, SliderConfig[]> = {}
  for (const s of SLIDERS) {
    if (!groups[s.group]) groups[s.group] = []
    groups[s.group].push(s)
  }

  const b = result?.baseline
  const e = result?.experiment
  const candidatePlans = result?.candidate_plans || []
  const recoveryPlans = (result?.recovery_options || []).map(r => r.plan)
  const allAvailablePlans = [...candidatePlans, ...recoveryPlans]
  const selectedPlan = allAvailablePlans.find(p => p.id === selectedPlanId) || candidatePlans.find(p => p.is_recommended) || (candidatePlans.find(p => p.safety_passed) ?? null)
  const canApply = Boolean(selectedPlan && (selectedPlan.safety_passed || selectedPlan.strategy_type === 'EMERGENCY_CONSERVATION'))

  return (
    <div className="sandbox-page" style={{ maxWidth: 1600, margin: '0 auto' }}>
      {/* Header */}
      <div className="page-header" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: 0.5 }}>JUDGE SANDBOX &amp; DECISION ENGINE</h2>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            Test station perturbations, evaluate genuine candidate operating plans, and apply optimal strategies in real time.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {loading && <span className="badge caution" style={{ fontSize: 11, animation: 'pulse 1s infinite' }}>RECALCULATING PLANS...</span>}
          {result && (
            <span className="badge" style={{ fontSize: 11, fontFamily: 'var(--mono)', background: 'var(--bg-darker)' }}>
              v{result.state_version}
            </span>
          )}
        </div>
      </div>

      {/* Notifications */}
      {error && (
        <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.12)', border: '1px solid var(--red)', borderRadius: 6, color: 'var(--red)', fontSize: 12, marginBottom: 14 }}>
          <strong>Error:</strong> {error}
        </div>
      )}
      {applySuccess && (
        <div style={{ padding: '10px 14px', background: 'rgba(34,197,94,0.12)', border: '1px solid var(--green)', borderRadius: 6, color: 'var(--green)', fontSize: 12, marginBottom: 14 }}>
          <strong>✓ Success:</strong> {applySuccess}
        </div>
      )}

      {/* Main 3-Column Layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 360px 1fr', gap: 16, alignItems: 'start' }}>

        {/* COLUMN 1: Sliders, Toggles, Presets */}
        <div>
          <div className="card" style={{ padding: 14 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)' }}>
              Station Controls
            </h3>

            {/* Presets */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 6 }}>
                Quick Presets
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {PRESETS.map(p => (
                  <button
                    key={p.label}
                    onClick={() => handlePreset(p)}
                    style={{
                      fontSize: 10, padding: '4px 8px', borderRadius: 4,
                      border: '1px solid var(--border)', background: 'var(--bg-darker)',
                      color: 'var(--text-secondary)', cursor: 'pointer',
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Discrete Toggles */}
            <div style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                System Toggles
              </div>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, cursor: 'pointer' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Generator Available</span>
                <input
                  type="checkbox"
                  checked={toggles.generator_available}
                  onChange={() => handleToggle('generator_available')}
                  style={{ accentColor: 'var(--green)' }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, cursor: 'pointer' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Communication Loss</span>
                <input
                  type="checkbox"
                  checked={toggles.communication_loss}
                  onChange={() => handleToggle('communication_loss')}
                  style={{ accentColor: 'var(--caution)' }}
                />
              </label>
            </div>

            {/* Slider Groups */}
            {Object.entries(groups).map(([groupName, sliders]) => (
              <div key={groupName} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 6 }}>
                  {groupName}
                </div>
                {sliders.map(s => {
                  const val = localValues[s.key] ?? s.min
                  return (
                    <div key={s.key} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{s.label}</span>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {val}{s.unit}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={s.min}
                        max={s.max}
                        step={s.step}
                        value={val}
                        onChange={e => handleSliderChange(s.key, parseFloat(e.target.value))}
                        style={{ width: '100%', accentColor: 'var(--cyan)' }}
                      />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        {/* COLUMN 2: Deltas, Trace, Intelligence Audit */}
        <div>
          <div className="card" style={{ padding: 14 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)' }}>
              State &amp; Risk Impact
            </h3>

            {!result ? (
              <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-dim)', fontSize: 12 }}>
                Modify controls to simulate state impact...
              </div>
            ) : b && e && (
              <>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 14 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 600, color: 'var(--text-dim)', fontSize: 10 }}>METRIC</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600, color: 'var(--text-dim)', fontSize: 10 }}>BASE</th>
                      <th style={{ textAlign: 'center', padding: '4px 2px', width: 20 }}></th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600, color: 'var(--text-dim)', fontSize: 10 }}>EXP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'Battery SOC', bv: b.battery_soc, ev: e.battery_soc, unit: '%', hib: true },
                      { label: 'Battery SOH', bv: b.battery_soh, ev: e.battery_soh, unit: '%', hib: true },
                      { label: 'Fuel Level', bv: b.fuel_l, ev: e.fuel_l, unit: ' L', hib: true },
                      { label: 'Resupply Delay', bv: b.resupply_delay_days, ev: e.resupply_delay_days, unit: ' d', hib: false },
                    ].map(row => (
                      <tr key={row.label} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '4px 6px', color: 'var(--text-secondary)' }}>{row.label}</td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)' }}>{row.bv?.toFixed(1)}{row.unit}</td>
                        <td style={{ textAlign: 'center', fontSize: 12, color: deltaColor(row.bv ?? 0, row.ev ?? 0, row.hib) }}>
                          {deltaArrow(row.bv ?? 0, row.ev ?? 0)}
                        </td>
                        <td style={{ padding: '4px 6px', textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 600, color: deltaColor(row.bv ?? 0, row.ev ?? 0, row.hib) }}>
                          {row.ev?.toFixed(1)}{row.unit}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Real-time Deltas */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <DeltaCard label="Safe Operability" baseline={b.safe_operability_days} experiment={e.safe_operability_days} unit="d" higherIsBetter />
                  <DeltaCard label="CQRM Margin" baseline={b.cqrm_days} experiment={e.cqrm_days} unit="d" higherIsBetter />
                  <RiskDelta label="Risk Level" baseline={b.risk_level} experiment={e.risk_level} />
                  <DeltaCard label="Reserve Floor" baseline={b.reserve_target} experiment={e.reserve_target} unit="%" higherIsBetter={false} />
                </div>
              </>
            )}
          </div>

          {/* Decision Trace */}
          {result && (
            <div className="card" style={{ padding: 14, marginTop: 14 }}>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                Decision Trace
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {result.execution_trace.map((step, i) => (
                  <TraceStep key={i} step={step} isLast={i === result.execution_trace.length - 1} />
                ))}
              </div>
            </div>
          )}

          {/* Intelligence Audit */}
          {result && (
            <div className="card" style={{ padding: 14, marginTop: 14 }}>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                Predictive &amp; Decision Engines
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {[
                  { name: 'Demand Forecast', type: 'ML (XGBoost)', status: 'complete' },
                  { name: 'Solar Forecast', type: 'ML (XGBoost)', status: 'complete' },
                  { name: 'Wind Forecast', type: 'ML (XGBoost)', status: 'complete' },
                  { name: 'Battery Health', type: 'ML (RandomForest)', status: 'complete' },
                  { name: 'Resupply Logistics', type: 'Stochastic P90', status: 'complete' },
                  { name: 'LP Optimizer', type: 'Highs Solver', status: result.plan_summary.method.includes('linear') ? 'complete' : 'fallback' },
                  { name: 'Safety Gate', type: 'Deterministic', status: result.safety.passed ? 'complete' : 'rejected' },
                ].map(eng => (
                  <div key={eng.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '4px 6px', background: 'var(--bg-darker)', borderRadius: 4 }}>
                    <span style={{ color: eng.status === 'complete' ? 'var(--green)' : eng.status === 'rejected' ? 'var(--red)' : 'var(--caution)', fontSize: 12 }}>
                      {eng.status === 'complete' ? '\u2713' : eng.status === 'rejected' ? '\u2717' : '\u26A0'}
                    </span>
                    <div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: 10, fontWeight: 600 }}>{eng.name}</div>
                      <div style={{ color: 'var(--text-dim)', fontSize: 9 }}>{eng.type}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* COLUMN 3: WHAT SHOULD WE DO? (Adaptive Plan Recommendation Engine) */}
        <div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--cyan)' }}>
                  WHAT CAN WE DO?
                </h3>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                  Genuine candidate plans evaluated by LP optimizer &amp; deterministic safety validator.
                </div>
              </div>

              {result?.feasible_count !== undefined && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <span className="badge" style={{ background: 'rgba(34,197,94,0.15)', color: 'var(--green)', border: '1px solid var(--green)', fontSize: 10 }}>
                    {result.feasible_count} FEASIBLE
                  </span>
                  {result.rejected_count! > 0 && (
                    <span className="badge" style={{ background: 'rgba(239,68,68,0.15)', color: 'var(--red)', border: '1px solid var(--red)', fontSize: 10 }}>
                      {result.rejected_count} REJECTED
                    </span>
                  )}
                </div>
              )}
            </div>

            {!result ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)', fontSize: 13 }}>
                Awaiting experiment inputs to generate candidate operating plans...
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                {/* All Plans Unsafe Warning Banner */}
                {result.feasible_count === 0 && (
                  <div style={{
                    padding: '12px 14px',
                    background: 'rgba(239,68,68,0.12)',
                    border: '1px solid var(--red)',
                    borderRadius: 8,
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--red)', letterSpacing: 0.5, marginBottom: 4 }}>
                      NO PLAN CURRENTLY PASSES ALL CONFIGURED CONSTRAINTS
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                      All {candidatePlans.length} nominal operating strategies fail safety validation under current extreme conditions. Review the evaluated trade-offs below or activate the emergency conservation recovery path.
                    </div>
                  </div>
                )}

                {/* Candidate Plan Cards (Always rendered with genuine metrics) */}
                {candidatePlans.map((plan, idx) => {
                  const isSelected = plan.id === selectedPlanId
                  const isRecommended = plan.is_recommended
                  const isSafe = plan.safety_passed
                  const isExpanded = expandedPlanId === plan.id
                  const isTechExpanded = showTechnicalDetails === plan.id

                  return (
                    <div
                      key={plan.id}
                      style={{
                        padding: 12,
                        borderRadius: 8,
                        border: isSelected
                          ? '2px solid var(--cyan)'
                          : isRecommended
                          ? '1px solid var(--green)'
                          : isSafe
                          ? '1px solid var(--border)'
                          : '1px solid rgba(239,68,68,0.35)',
                        background: isSelected
                          ? 'rgba(6,182,212,0.08)'
                          : isRecommended
                          ? 'rgba(34,197,94,0.04)'
                          : !isSafe
                          ? 'rgba(239,68,68,0.03)'
                          : 'var(--bg-darker)',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {/* Card Header */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: 0.5 }}>
                              OPTION {idx + 1}
                            </span>
                            {isRecommended && (
                              <span className="badge" style={{ background: 'rgba(34,197,94,0.2)', color: 'var(--green)', border: '1px solid var(--green)', fontSize: 9, fontWeight: 800 }}>
                                ★ POLAR-EMS RECOMMENDED
                              </span>
                            )}
                            {isSelected && (
                              <span className="badge" style={{ background: 'rgba(6,182,212,0.2)', color: 'var(--cyan)', border: '1px solid var(--cyan)', fontSize: 9, fontWeight: 700 }}>
                                SELECTED
                              </span>
                            )}
                            <span className="badge" style={{
                              background: isSafe ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                              color: isSafe ? 'var(--green)' : 'var(--red)',
                              fontSize: 9,
                            }}>
                              {isSafe ? '✓ PASS' : '✕ UNSAFE'}
                            </span>
                          </div>
                          <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
                            {plan.name}
                          </h4>
                        </div>

                        {/* Plan Confidence Tag */}
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                          background: isRecommended ? 'rgba(34,197,94,0.15)' : !isSafe ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.05)',
                          color: isRecommended ? 'var(--green)' : !isSafe ? 'var(--red)' : 'var(--text-dim)',
                        }}>
                          {plan.confidence}
                        </span>
                      </div>

                      {/* Plain Language Description */}
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.4 }}>
                        {plan.simple_description}
                      </div>

                      {/* Key Operational Metrics Grid */}
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 6,
                        padding: '8px 10px',
                        background: 'rgba(0,0,0,0.25)',
                        borderRadius: 6,
                        marginBottom: 8,
                        fontSize: 11,
                      }}>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Critical Load</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: plan.critical_coverage_pct >= 99 ? 'var(--green)' : 'var(--red)' }}>
                            {plan.critical_coverage_pct.toFixed(0)}%
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Non-Essential</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {plan.flex_reduction_pct > 0 ? `-${plan.flex_reduction_pct.toFixed(0)}%` : '100%'}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Generator</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {plan.generator_avg_kw > 0 ? `${plan.generator_avg_kw.toFixed(0)} kW` : '0 kW'}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>End SOC</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: plan.end_soc >= 30 ? 'var(--green)' : 'var(--caution)' }}>
                            {plan.end_soc.toFixed(0)}%
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Fuel (6h)</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {plan.fuel_6h_l.toFixed(1)} L
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>CQRM Margin</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: plan.cqrm_days >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            {plan.cqrm_days > 0 ? `+${plan.cqrm_days.toFixed(1)}d` : `${plan.cqrm_days.toFixed(1)}d`}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Safe Autonomy</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {plan.safe_operability_days.toFixed(1)}d
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Safety</div>
                          <div style={{ fontWeight: 700, color: isSafe ? 'var(--green)' : 'var(--red)' }}>
                            {isSafe ? 'PASS' : 'REJECT'}
                          </div>
                        </div>
                      </div>

                      {/* Action & Details Bar */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <button
                          onClick={() => handleSelectPlan(plan)}
                          disabled={!isSafe}
                          style={{
                            flex: 1,
                            padding: '6px 12px',
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: 0.5,
                            borderRadius: 4,
                            cursor: isSafe ? 'pointer' : 'not-allowed',
                            border: isSelected ? '1px solid var(--cyan)' : isRecommended ? '1px solid var(--green)' : '1px solid var(--border)',
                            background: !isSafe ? 'rgba(239,68,68,0.08)' : isSelected ? 'var(--cyan)' : isRecommended ? 'rgba(34,197,94,0.2)' : 'var(--bg-dark)',
                            color: !isSafe ? 'var(--red)' : isSelected ? '#000' : isRecommended ? 'var(--green)' : 'var(--text-primary)',
                          }}
                        >
                          {!isSafe ? '✕ NOT SAFE (NOT AVAILABLE FOR APPLICATION)' : isSelected ? '✓ SELECTED OPTION' : isRecommended ? 'SELECT RECOMMENDED' : 'SELECT PLAN'}
                        </button>

                        <button
                          onClick={() => setExpandedPlanId(isExpanded ? null : plan.id)}
                          style={{
                            fontSize: 10, padding: '4px 8px', borderRadius: 4,
                            border: '1px solid var(--border)', background: 'transparent',
                            color: 'var(--text-dim)', cursor: 'pointer',
                          }}
                        >
                          {isExpanded ? 'Hide Why' : !isSafe ? 'Why Unsafe?' : 'Why?'}
                        </button>

                        <button
                          onClick={() => setShowTechnicalDetails(isTechExpanded ? null : plan.id)}
                          style={{
                            fontSize: 10, padding: '4px 8px', borderRadius: 4,
                            border: '1px solid var(--border)', background: 'transparent',
                            color: 'var(--text-dim)', cursor: 'pointer',
                          }}
                        >
                          {isTechExpanded ? 'Hide Inputs' : 'Inputs'}
                        </button>
                      </div>

                      {/* Expandable Why Drawer */}
                      {isExpanded && (
                        <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.3)', borderRadius: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
                          <strong style={{ color: 'var(--text-primary)' }}>
                            {!isSafe ? 'Safety Disqualification Reason:' : isRecommended ? 'Why POLAR-EMS recommends this:' : 'Plan Trade-off Assessment:'}
                          </strong>
                          <div style={{ marginTop: 4, lineHeight: 1.4 }}>
                            {isRecommended ? plan.why_recommended : (plan.why_not_recommended || plan.simple_description)}
                          </div>
                          {!isSafe && plan.failed_reasons.length > 0 && (
                            <div style={{ marginTop: 6, color: 'var(--red)', fontSize: 10 }}>
                              <strong>Active Safety Violations:</strong>
                              <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>
                                {plan.failed_reasons.map((r, i) => <li key={i}>{r}</li>)}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Expandable Inputs & Models Drawer */}
                      {isTechExpanded && (
                        <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.3)', borderRadius: 6, fontSize: 10 }}>
                          <div style={{ fontWeight: 700, color: 'var(--text-dim)', marginBottom: 4, textTransform: 'uppercase' }}>
                            Predictive &amp; Decision Pipeline Inputs:
                          </div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {plan.ml_inputs_used.map(inp => (
                              <span key={inp.name} style={{ padding: '2px 6px', background: 'var(--bg-darker)', borderRadius: 3, color: 'var(--text-secondary)' }}>
                                ✓ {inp.name} ({inp.type})
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Emergency Recovery Action Card (When available in recovery_options) */}
                {result.recovery_options && result.recovery_options.length > 0 && result.recovery_options.map(rec => {
                  const recPlan = rec.plan
                  const isRecSelected = selectedPlanId === rec.id || selectedPlanId === recPlan.id
                  const recSafe = rec.safety_passed

                  return (
                    <div
                      key={rec.id}
                      style={{
                        padding: 14,
                        borderRadius: 8,
                        border: isRecSelected ? '2px solid var(--conserve)' : '1px solid var(--conserve)',
                        background: isRecSelected ? 'rgba(251,146,60,0.12)' : 'rgba(251,146,60,0.06)',
                        marginTop: 4,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                            <span className="badge" style={{ background: 'rgba(251,146,60,0.2)', color: 'var(--conserve)', border: '1px solid var(--conserve)', fontSize: 9, fontWeight: 800 }}>
                              ⚠ RECOVERY ACTION
                            </span>
                            {isRecSelected && (
                              <span className="badge" style={{ background: 'rgba(6,182,212,0.2)', color: 'var(--cyan)', border: '1px solid var(--cyan)', fontSize: 9, fontWeight: 700 }}>
                                SELECTED
                              </span>
                            )}
                            <span className="badge" style={{
                              background: recSafe ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                              color: recSafe ? 'var(--green)' : 'var(--red)',
                              fontSize: 9,
                            }}>
                              {recSafe ? '✓ SAFE RECOVERY' : '✕ CONSTRAINED'}
                            </span>
                          </div>
                          <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: 'var(--conserve)' }}>
                            {rec.name}
                          </h4>
                        </div>
                      </div>

                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.4 }}>
                        {rec.description}
                      </div>

                      {/* Primary Limitation notice if unsafe */}
                      {!recSafe && rec.primary_limitation && (
                        <div style={{ padding: '6px 10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: 'var(--red)', fontSize: 11, marginBottom: 8 }}>
                          <strong>Primary Limitation:</strong> {rec.primary_limitation}
                        </div>
                      )}

                      {/* Recovery Action Metrics */}
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 6,
                        padding: '8px 10px',
                        background: 'rgba(0,0,0,0.25)',
                        borderRadius: 6,
                        marginBottom: 10,
                        fontSize: 11,
                      }}>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Critical Load</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--green)' }}>
                            {recPlan.critical_coverage_pct.toFixed(0)}%
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Non-Essential</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--conserve)' }}>
                            -{recPlan.flex_reduction_pct.toFixed(0)}% (Curtailed)
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>Safe Autonomy</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {recPlan.safe_operability_days.toFixed(1)}d
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase' }}>CQRM Margin</div>
                          <div style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: recPlan.cqrm_days >= 0 ? 'var(--green)' : 'var(--caution)' }}>
                            {recPlan.cqrm_days > 0 ? `+${recPlan.cqrm_days.toFixed(1)}d` : `${recPlan.cqrm_days.toFixed(1)}d`}
                          </div>
                        </div>
                      </div>

                      {/* Enter Emergency Conservation Button */}
                      <button
                        onClick={() => {
                          setSelectedPlanId(recPlan.id)
                        }}
                        style={{
                          width: '100%',
                          padding: '8px 14px',
                          fontSize: 12,
                          fontWeight: 800,
                          letterSpacing: 0.5,
                          borderRadius: 6,
                          cursor: 'pointer',
                          border: '1px solid var(--conserve)',
                          background: isRecSelected ? 'var(--conserve)' : 'rgba(251,146,60,0.2)',
                          color: isRecSelected ? '#000' : 'var(--conserve)',
                        }}
                      >
                        {isRecSelected ? '✓ EMERGENCY CONSERVATION SELECTED' : '[ ENTER EMERGENCY CONSERVATION ]'}
                      </button>
                    </div>
                  )
                })}

                {/* Plan Comparison Table */}
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 6 }}>
                    Candidate Plans Side-by-Side Comparison
                  </div>
                  {candidatePlans.length > 0 ? (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <th style={{ textAlign: 'left', padding: '6px 4px', color: 'var(--text-dim)', fontSize: 10 }}>METRIC</th>
                            {candidatePlans.map(p => (
                              <th
                                key={p.id}
                                style={{
                                  textAlign: 'right', padding: '6px 4px', fontSize: 10,
                                  color: p.id === selectedPlanId ? 'var(--cyan)' : p.is_recommended ? 'var(--green)' : 'var(--text-secondary)',
                                  fontWeight: p.id === selectedPlanId || p.is_recommended ? 700 : 500,
                                }}
                              >
                                {p.short_name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '5px 4px', color: 'var(--text-secondary)' }}>Critical Load</td>
                            {candidatePlans.map(p => (
                              <td key={p.id} style={{ textAlign: 'right', fontFamily: 'var(--mono)', padding: '5px 4px', color: p.critical_coverage_pct >= 99 ? 'var(--green)' : 'var(--red)' }}>
                                {p.critical_coverage_pct.toFixed(0)}%
                              </td>
                            ))}
                          </tr>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '5px 4px', color: 'var(--text-secondary)' }}>Non-Essential Load</td>
                            {candidatePlans.map(p => (
                              <td key={p.id} style={{ textAlign: 'right', fontFamily: 'var(--mono)', padding: '5px 4px' }}>
                                {p.flex_load_pct.toFixed(0)}%
                              </td>
                            ))}
                          </tr>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '5px 4px', color: 'var(--text-secondary)' }}>End SOC</td>
                            {candidatePlans.map(p => (
                              <td key={p.id} style={{ textAlign: 'right', fontFamily: 'var(--mono)', padding: '5px 4px' }}>
                                {p.end_soc.toFixed(0)}%
                              </td>
                            ))}
                          </tr>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '5px 4px', color: 'var(--text-secondary)' }}>Fuel Used (6h)</td>
                            {candidatePlans.map(p => (
                              <td key={p.id} style={{ textAlign: 'right', fontFamily: 'var(--mono)', padding: '5px 4px' }}>
                                {p.fuel_6h_l.toFixed(1)} L
                              </td>
                            ))}
                          </tr>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '5px 4px', color: 'var(--text-secondary)' }}>CQRM Margin</td>
                            {candidatePlans.map(p => (
                              <td key={p.id} style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 700, padding: '5px 4px', color: p.cqrm_days >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                {p.cqrm_days > 0 ? `+${p.cqrm_days.toFixed(1)}d` : `${p.cqrm_days.toFixed(1)}d`}
                              </td>
                            ))}
                          </tr>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '5px 4px', color: 'var(--text-secondary)' }}>Safety Gate</td>
                            {candidatePlans.map(p => (
                              <td key={p.id} style={{ textAlign: 'right', fontWeight: 700, padding: '5px 4px', color: p.safety_passed ? 'var(--green)' : 'var(--red)' }}>
                                {p.safety_passed ? 'PASS' : 'REJECT'}
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-dim)', fontSize: 11, background: 'var(--bg-darker)', borderRadius: 6 }}>
                      No candidate plans evaluated
                    </div>
                  )}
                </div>

                {/* Selected Plan Preview Before Apply */}
                {selectedPlan && (
                  <div style={{ marginTop: 14, padding: 12, background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.3)', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--cyan)', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                        PLAN PREVIEW: {selectedPlan.name}
                      </div>
                      <span className="badge" style={{ background: 'rgba(6,182,212,0.2)', color: 'var(--cyan)', fontSize: 9 }}>
                        READY TO COMMIT
                      </span>
                    </div>

                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                      Impact on global station state upon applying this operating plan:
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, fontSize: 11 }}>
                      <div style={{ padding: 6, background: 'var(--bg-darker)', borderRadius: 4 }}>
                        <span style={{ color: 'var(--text-dim)', fontSize: 9, display: 'block' }}>FLEXIBLE DEMAND</span>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>100% → {selectedPlan.flex_load_pct.toFixed(0)}%</span>
                      </div>
                      <div style={{ padding: 6, background: 'var(--bg-darker)', borderRadius: 4 }}>
                        <span style={{ color: 'var(--text-dim)', fontSize: 9, display: 'block' }}>GENERATOR AVG</span>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{station?.balance.diesel_kw ?? 0} → {selectedPlan.generator_avg_kw.toFixed(0)} kW</span>
                      </div>
                      <div style={{ padding: 6, background: 'var(--bg-darker)', borderRadius: 4 }}>
                        <span style={{ color: 'var(--text-dim)', fontSize: 9, display: 'block' }}>CQRM MARGIN</span>
                        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: selectedPlan.cqrm_days >= 0 ? 'var(--green)' : 'var(--red)' }}>
                          {station?.autonomy.cqrm_margin_days.toFixed(1)}d → {selectedPlan.cqrm_days > 0 ? `+${selectedPlan.cqrm_days.toFixed(1)}d` : `${selectedPlan.cqrm_days.toFixed(1)}d`}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Apply Action Buttons */}
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    onClick={handleApply}
                    disabled={applying || !canApply}
                    style={{
                      width: '100%',
                      padding: 12,
                      fontSize: 13,
                      fontWeight: 800,
                      letterSpacing: 0.5,
                      background: canApply ? 'var(--green)' : undefined,
                      color: canApply ? '#000' : undefined,
                      opacity: !canApply ? 0.5 : 1,
                      cursor: canApply ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {applying
                      ? 'APPLYING PLAN GLOBALLY...'
                      : !selectedPlan
                      ? (candidatePlans.length === 0 ? 'NO PLANS AVAILABLE' : 'SELECT A PLAN TO APPLY')
                      : !canApply
                      ? `CANNOT APPLY UNSAFE PLAN (${selectedPlan.short_name.toUpperCase()})`
                      : `APPLY "${selectedPlan.short_name.toUpperCase()}" TO SIMULATION`}
                  </button>

                  <button
                    className="btn"
                    onClick={handleReset}
                    style={{ width: '100%', fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', background: 'transparent' }}
                  >
                    RESET TO CANONICAL DEMO BASELINE
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Sub-components ----

const DeltaCard: React.FC<{
  label: string
  baseline: number
  experiment: number
  unit: string
  higherIsBetter: boolean
}> = ({ label, baseline, experiment, unit, higherIsBetter }) => {
  const color = deltaColor(baseline, experiment, higherIsBetter)
  const arrow = deltaArrow(baseline, experiment)
  return (
    <div style={{ padding: '8px 10px', background: 'var(--bg-darker)', borderRadius: 6, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>{baseline.toFixed(1)}{unit}</span>
        <span style={{ fontSize: 12, color }}>{arrow}</span>
        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono)', color }}>{experiment.toFixed(1)}{unit}</span>
      </div>
    </div>
  )
}

const RiskDelta: React.FC<{
  label: string
  baseline: string
  experiment: string
}> = ({ label, baseline, experiment }) => {
  return (
    <div style={{ padding: '8px 10px', background: 'var(--bg-darker)', borderRadius: 6, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span className={`badge ${baseline.toLowerCase()}`} style={{ fontSize: 9 }}>{baseline}</span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{'\u2192'}</span>
        <span className={`badge ${experiment.toLowerCase()}`} style={{ fontSize: 9, fontWeight: 700 }}>{experiment}</span>
      </div>
    </div>
  )
}

const TraceStep: React.FC<{ step: ExecutionTraceStep; isLast: boolean }> = ({ step, isLast }) => (
  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 16 }}>
      <div style={{
        width: 14, height: 14, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: step.status === 'complete' ? 'var(--green)' : step.status === 'failed' ? 'var(--red)' : 'var(--text-dim)',
        color: '#fff', fontSize: 8, fontWeight: 700,
      }}>
        {step.status === 'complete' ? '\u2713' : step.status === 'failed' ? '\u2717' : '...'}
      </div>
      {!isLast && <div style={{ width: 1, height: 14, background: 'var(--border)' }} />}
    </div>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: 0.2 }}>
        {step.step.replace(/_/g, ' ')}
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>{step.detail}</div>
    </div>
  </div>
)
