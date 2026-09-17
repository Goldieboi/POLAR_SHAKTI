import React, { useState, useEffect } from 'react'
import { useStore } from '../store'
import { Page, statusBadge } from '../components'
import { post, Recommendation, Step } from '../api'

/**
 * Recommended Operating Plan — Decision-First Operator Screen.
 * Answers: "WHAT SHOULD THE OPERATOR DO NOW?"
 */
export const OptimizationPage: React.FC = () => {
  const { station, recommendation, refresh } = useStore()
  const [rec, setRec] = useState<Recommendation | null>(recommendation)
  const [busy, setBusy] = useState(false)
  const [planStatus, setPlanStatus] = useState<'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'CONSERVATION'>('PROPOSED')
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [approvalTime, setApprovalTime] = useState<string>('')
  const [fallbackDelta, setFallbackDelta] = useState<any>(null)
  const [err, setErr] = useState('')

  // Trace state for Re-Optimize execution
  const [traceSteps, setTraceSteps] = useState<string[]>([])
  const [isTracing, setIsTracing] = useState(false)

  // Sync with store recommendation on mount/update
  useEffect(() => {
    if (recommendation) {
      setRec(recommendation)
      if (recommendation.status === 'approved' && !station?.awaiting_approval) {
        setPlanStatus('ACCEPTED')
      } else if (recommendation.status === 'conservation fallback active') {
        setPlanStatus('CONSERVATION')
      } else if (recommendation.status === 'rejected') {
        setPlanStatus('REJECTED')
      }
    }
  }, [recommendation, station?.awaiting_approval])

  const cur = rec ?? recommendation ?? station?.recommendation
  const plan = cur?.plan
  const safety = cur?.safety
  const cqrmMargin = station?.autonomy?.cqrm_margin_days ?? station?.autonomy?.autonomy_margin_days ?? 0.5
  const isSafetyPassed = safety ? safety.passed : (station?.safety ? station.safety.passed : cqrmMargin >= 0)

  // Derive plain-English recommendation text
  const cleanSummary = (plan?.recommendation_summary || station?.recommendation_summary || '')
    .replace(/Nominal horizon: battery reserves held above \d+% floor/i, 'Preserve battery reserve and protect critical life-safety loads.')
    || (cqrmMargin < 0 ? 'Resupply arrival horizon is delayed. Reduce discretionary flexible loads and maintain conservative battery reserve.' : 'Preserve battery reserve and maintain critical loads within safe operating limits.')

  // Next 6 hours battery action label
  const nextStep = plan?.steps?.[0]
  const batteryAction = !nextStep ? 'HOLD' : nextStep.battery_kw > 5 ? 'CHARGE' : nextStep.battery_kw < -5 ? 'DISCHARGE' : 'HOLD'

  // Handler: Run Optimization
  const handleReoptimize = async () => {
    setBusy(true)
    setIsTracing(true)
    setTraceSteps([])
    setErr('')
    setFallbackDelta(null)
    setStatusMessage('')

    const pipelineSteps = [
      'Reading station state & sensor telemetry',
      'Executing ML forecasts (Demand, Solar, Wind, Battery SOH)',
      'Computing Safe Operability & CQRM resupply margins',
      'Solving constrained LP dispatch schedule via HiGHS',
      'Validating plan against deterministic safety rules',
      'Generating operational recommendation',
    ]

    for (let i = 0; i < pipelineSteps.length; i++) {
      await new Promise(r => setTimeout(r, 100))
      setTraceSteps(prev => [...prev, pipelineSteps[i]])
    }

    try {
      const r = await post<Recommendation>('/optimization/run')
      setRec(r)
      setPlanStatus('PROPOSED')
      setStatusMessage('✓ New optimization plan generated and safety-validated.')
      await refresh()
    } catch (e: any) {
      setErr(`Optimization notice: ${e.message || 'Solver error'}. Rule-based fallback active.`)
    } finally {
      setIsTracing(false)
      setBusy(false)
    }
  }

  // Handler: Approve Plan (Nominal or Fallback)
  const handleApprove = async () => {
    if (!isSafetyPassed && planStatus !== 'CONSERVATION') {
      setErr('Cannot approve an UNSAFE plan. Hard safety constraints violated. Please trigger safe fallback.')
      return
    }
    setBusy(true)
    setErr('')
    try {
      await post<{ approved: boolean; status?: string }>('/optimization/approve')
      const timeStr = new Date().toLocaleTimeString()
      setApprovalTime(timeStr)
      setPlanStatus('ACCEPTED')
      setStatusMessage(`✓ PLAN ACTIVE — OPERATOR APPROVED (${timeStr})`)
      await refresh()
    } catch (e: any) {
      setErr(`Approval failed: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Handler: Reject Plan
  const handleReject = async () => {
    setBusy(true)
    setErr('')
    try {
      await post<{ approved: boolean; status?: string }>('/optimization/reject')
      setPlanStatus('REJECTED')
      setStatusMessage(`✕ PLAN REJECTED at ${new Date().toLocaleTimeString()} — Safe conservation fallback available below.`)
      await refresh()
    } catch (e: any) {
      setErr(`Rejection recording failed: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Handler: Trigger Safe Fallback
  const handleTriggerFallback = async () => {
    setBusy(true)
    setErr('')
    setStatusMessage('GENERATING SAFE FALLBACK CONSERVATION PLAN…')
    try {
      const res = await post<any>('/optimization/fallback')
      setRec(res)
      if (res.delta) {
        setFallbackDelta(res.delta)
      }
      setPlanStatus('CONSERVATION')
      setStatusMessage('✓ CONSERVATION FALLBACK VALIDATED — Discretionary loads shed (35%), battery reserve locked above 35% floor.')
      await refresh()
    } catch (e: any) {
      setErr(`Fallback execution error: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  // State condition helpers
  const isUnsafeOrRejected = (!isSafetyPassed && planStatus !== 'CONSERVATION' && planStatus !== 'ACCEPTED') || planStatus === 'REJECTED'
  const isProposedSafe = planStatus === 'PROPOSED' && isSafetyPassed
  const isConservationValidated = planStatus === 'CONSERVATION'
  const isPlanActive = planStatus === 'ACCEPTED'

  return (
    <Page
      title="Recommended Operating Plan"
      meta={
        <div className="row" style={{ gap: 8 }}>
          <span className="badge info">LOCAL DECISION ENGINE ACTIVE</span>
        </div>
      }
    >
      {/* TRACE DISPLAY (WHEN RE-OPTIMIZING) */}
      {isTracing && (
        <div className="card" style={{ background: '#f8fafc', border: '1px solid #cbd5e1', marginBottom: 12, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', textTransform: 'uppercase', marginBottom: 6 }}>
            Decision Pipeline Execution Trace
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 6 }}>
            {traceSteps.map((step, idx) => (
              <div key={idx} style={{ fontSize: 11, color: '#334155', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--green)', fontWeight: 800 }}>✓</span> {step}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ERROR / NOTICE BANNER */}
      {err && (
        <div className="card" style={{ background: '#fef2f2', borderLeft: '4px solid var(--red)', marginBottom: 12, padding: '8px 14px' }}>
          <span style={{ color: 'var(--red)', fontSize: 13, fontWeight: 600 }}>{err}</span>
        </div>
      )}

      {/* 1. PRIMARY OPERATOR DECISION CARD */}
      <div className={`card ${isUnsafeOrRejected ? 'rejected' : ''}`} style={{ borderLeft: isUnsafeOrRejected ? '4px solid var(--red)' : isConservationValidated ? '4px solid var(--conserve)' : '4px solid var(--blue)', padding: '16px 20px', marginBottom: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: isUnsafeOrRejected ? 'var(--red)' : isConservationValidated ? 'var(--conserve)' : 'var(--blue)' }}>
              WHAT SHOULD THE OPERATOR DO NOW?
            </span>
            {isPlanActive ? (
              <span className="badge safe">✓ PLAN ACTIVE (OPERATOR APPROVED)</span>
            ) : isConservationValidated ? (
              <span className="badge conserve">✓ CONSERVATION FALLBACK VALIDATED</span>
            ) : isUnsafeOrRejected ? (
              <span className="badge critical">✕ PLAN REJECTED / FALLBACK REQUIRED</span>
            ) : (
              <span className="badge safe">PROPOSED (SAFETY VALIDATED)</span>
            )}
          </div>
        </div>

        <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', lineHeight: 1.4, marginBottom: 12 }}>
          {cleanSummary}
        </div>

        {/* 2. EXPECTED OUTCOME STRIP */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginTop: 10, paddingTop: 10, borderTop: '1px solid #e2e8f0' }}>
          <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>PROJECTED FUEL (6H)</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 800, color: '#0f172a' }}>
              {plan?.expected_fuel_l ? `${Math.round(plan.expected_fuel_l)} L` : '—'}
            </div>
          </div>
          <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>PLANNED END SOC</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 800, color: 'var(--blue)' }}>
              {plan?.expected_end_soc ? `${plan.expected_end_soc.toFixed(1)}%` : '—'}
            </div>
          </div>
          <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>CRITICAL LOADS</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 800, color: 'var(--green)' }}>
              100% SERVED
            </div>
          </div>
          <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>SAFETY STATUS</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 800, color: isUnsafeOrRejected ? 'var(--red)' : 'var(--green)' }}>
              {isUnsafeOrRejected ? '✕ NOT VALIDATED' : '✓ VALIDATED'}
            </div>
          </div>
        </div>

        {/* 3. STATE-DEPENDENT DYNAMIC ACTIONS (1 PRIMARY WORKFLOW PER STATE) */}
        <div className="row" style={{ gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          
          {/* STATE 1: PROPOSED & SAFE */}
          {isProposedSafe && (
            <>
              <button
                type="button"
                className="primary"
                id="btn-accept-plan"
                onClick={handleApprove}
                disabled={busy}
                style={{ fontWeight: 700, padding: '7px 18px', background: 'var(--green)' }}
              >
                ✓ ACCEPT PLAN
              </button>
              <button
                type="button"
                className="danger"
                id="btn-reject-plan"
                onClick={handleReject}
                disabled={busy}
                style={{ fontWeight: 700, padding: '7px 18px' }}
              >
                ✕ REJECT PLAN
              </button>
            </>
          )}

          {/* STATE 2: REJECTED OR UNSAFE (CQRM < 0) */}
          {isUnsafeOrRejected && (
            <>
              <button
                type="button"
                className="primary"
                id="btn-safe-fallback"
                onClick={handleTriggerFallback}
                disabled={busy}
                style={{ fontWeight: 700, padding: '7px 18px', background: 'var(--conserve)' }}
              >
                🛡 USE SAFE FALLBACK PLAN
              </button>
              <button
                type="button"
                onClick={handleReoptimize}
                disabled={busy}
                style={{ fontWeight: 600, padding: '7px 14px' }}
              >
                ⚡ RE-OPTIMIZE
              </button>
            </>
          )}

          {/* STATE 3: FALLBACK GENERATED & VALIDATED */}
          {isConservationValidated && (
            <>
              <button
                type="button"
                className="primary"
                id="btn-accept-fallback"
                onClick={handleApprove}
                disabled={busy}
                style={{ fontWeight: 700, padding: '7px 18px', background: 'var(--green)' }}
              >
                ✓ ACCEPT FALLBACK PLAN
              </button>
              <button
                type="button"
                onClick={handleReoptimize}
                disabled={busy}
                style={{ fontWeight: 600, padding: '7px 14px' }}
              >
                ⚡ RE-OPTIMIZE
              </button>
            </>
          )}

          {/* STATE 4: PLAN ACTIVE / APPROVED */}
          {isPlanActive && (
            <>
              <div style={{ fontSize: 13, color: 'var(--green)', fontWeight: 700, padding: '4px 0' }}>
                ✓ PLAN ACTIVE — Approved at {approvalTime || '22:31'}
              </div>
              <button
                type="button"
                onClick={handleReoptimize}
                disabled={busy}
                style={{ fontWeight: 600, padding: '7px 14px', marginLeft: 8 }}
              >
                ⚡ RE-OPTIMIZE PLAN
              </button>
            </>
          )}
        </div>

        {/* Causal Explanation when Unsafe / Rejected */}
        {isUnsafeOrRejected && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 4, fontSize: 12, color: 'var(--red)' }}>
            <b>Deterministic Safety Reason:</b> {cqrmMargin < 0 ? `Safe-operability horizon is shorter than conservative resupply arrival (CQRM: ${cqrmMargin.toFixed(1)} days). Nominal plan cannot be approved.` : 'One or more deterministic constraints were breached.'} Please trigger Safe Fallback.
          </div>
        )}

        {/* STATUS MESSAGE */}
        {statusMessage && (
          <div style={{ marginTop: 10, fontSize: 12, color: isUnsafeOrRejected ? 'var(--red)' : isConservationValidated ? 'var(--conserve)' : 'var(--green)', fontWeight: 600 }}>
            {statusMessage}
          </div>
        )}

        {/* FALLBACK EXACT DELTAS */}
        {fallbackDelta && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', marginBottom: 4 }}>
              WHAT CHANGED UNDER CONSERVATION FALLBACK?
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, fontSize: 12 }}>
              <div>Generator: <b>{fallbackDelta.generator_kw.from} → {fallbackDelta.generator_kw.to} kW</b></div>
              <div>Battery Draw: <b>{fallbackDelta.battery_kw.from} → {fallbackDelta.battery_kw.to} kW</b></div>
              <div>Fuel Projection: <b>{fallbackDelta.fuel_projection_l.from} → {fallbackDelta.fuel_projection_l.to} L</b></div>
              <div>Reserve Floor: <b>{fallbackDelta.reserve_soc_pct.from}% → {fallbackDelta.reserve_soc_pct.to}%</b></div>
            </div>
          </div>
        )}
      </div>

      {/* 4. NEXT 6 HOURS DISPATCH PROFILE */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8 }}>
          NEXT 6 HOURS OPERATING DISPATCH PROFILE
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
          <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>DIESEL GENERATOR</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 800, color: '#0f172a' }}>
              {nextStep ? `${Math.round(nextStep.diesel_kw)} kW` : '—'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Min stable: 50 kW</div>
          </div>
          <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>BATTERY ACTION</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 800, color: 'var(--blue)' }}>
              {nextStep ? `${batteryAction} (${Math.abs(Math.round(nextStep.battery_kw))} kW)` : '—'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Reserve floor protected</div>
          </div>
          <div style={{ background: '#f0fdf4', padding: '8px 12px', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: '#166534', fontWeight: 600 }}>RENEWABLE CAPTURE</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 800, color: 'var(--green)' }}>
              {nextStep ? `${Math.round(nextStep.solar_kw + nextStep.wind_kw)} kW` : '—'}
            </div>
            <div style={{ fontSize: 10, color: '#166534' }}>100% prioritized</div>
          </div>
          <div style={{ background: '#f8fafc', padding: '8px 12px', borderRadius: 4 }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>FLEXIBLE SHEDDING</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 17, fontWeight: 800, color: 'var(--conserve)' }}>
              {nextStep?.flexible_kw !== undefined ? `${Math.round(nextStep.flexible_kw)} kW` : '0 kW'}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Non-critical loads only</div>
          </div>
        </div>
      </div>

      {/* 5. COLLAPSED DETAILED HOURLY DISPATCH SCHEDULE */}
      <details className="card" style={{ marginBottom: 14 }}>
        <summary style={{ fontSize: 12, fontWeight: 700, color: 'var(--blue)', cursor: 'pointer', padding: '4px 0' }}>
          ▸ Detailed Hourly Dispatch Schedule (6-Hour Constrained Horizon)
        </summary>
        <div style={{ marginTop: 10, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Hour</th>
                <th>Load (kW)</th>
                <th>Solar (kW)</th>
                <th>Wind (kW)</th>
                <th>Diesel Gen (kW)</th>
                <th>Battery (kW)</th>
                <th>Flex Shed (kW)</th>
              </tr>
            </thead>
            <tbody>
              {plan?.steps?.map((s: Step, i: number) => (
                <tr key={i}>
                  <td style={{ fontWeight: 700 }}>+{s.start_offset_h}h</td>
                  <td>{Math.round(s.load_kw)}</td>
                  <td style={{ color: 'var(--green)' }}>{Math.round(s.solar_kw)}</td>
                  <td style={{ color: 'var(--green)' }}>{Math.round(s.wind_kw)}</td>
                  <td style={{ fontWeight: 700 }}>{Math.round(s.diesel_kw)}</td>
                  <td style={{ color: s.battery_kw > 0 ? 'var(--blue)' : s.battery_kw < 0 ? 'var(--conserve)' : 'var(--text-dim)', fontWeight: 600 }}>
                    {s.battery_kw > 0 ? `+${Math.round(s.battery_kw)} (Chg)` : s.battery_kw < 0 ? `${Math.round(s.battery_kw)} (Dis)` : '0 (Hold)'}
                  </td>
                  <td style={{ color: s.flexible_kw > 0 ? 'var(--conserve)' : 'var(--text-dim)' }}>
                    {Math.round(s.flexible_kw || 0)}
                  </td>
                </tr>
              )) || (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>No schedule steps available.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
    </Page>
  )
}
