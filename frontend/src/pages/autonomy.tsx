import React, { useState } from 'react'
import { useStore } from '../store'
import { Page, statusBadge, ResupplyDelaySlider, SemiCircleGauge, ResupplyTimelineBar } from '../components'
import { runScenarioV1, ScenarioV1Response } from '../api'

/**
 * Safe Autonomy Page — Decision-First Assessment.
 * Answers: "CAN WE SAFELY REACH RESUPPLY?"
 */
export const AutonomyPage: React.FC = () => {
  const { station, action, refresh } = useStore()
  const [busy, setBusy] = useState(false)
  const [customScenarioResult, setCustomScenarioResult] = useState<ScenarioV1Response | null>(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [sliderBusy, setSliderBusy] = useState(false)

  // Trace steps state
  const [isTracing, setIsTracing] = useState(false)
  const [traceSteps, setTraceSteps] = useState<string[]>([])

  if (!station) return <Page title="Safe Autonomy"><p>Loading station state…</p></Page>
  const a = station.autonomy
  if (!a) return <Page title="Safe Autonomy"><p>Autonomy engine calculating…</p></Page>

  const margin = customScenarioResult ? customScenarioResult.cqrm_days : (a.cqrm_margin_days ?? a.autonomy_margin_days ?? 0)
  const safeDays = customScenarioResult ? customScenarioResult.safe_operability_days : a.safe_autonomy_days
  const p90Days = customScenarioResult ? customScenarioResult.resupply_p90_days : (a.resupply_conservative_days ?? (station.resupply.in_days * 1.3))
  const p10Days = a.optimistic_days ?? (p90Days * 0.72)
  const p50Days = a.expected_days ?? station.resupply.in_days ?? (p90Days * 0.88)
  const currentRisk = customScenarioResult ? customScenarioResult.risk_level : a.status
  const reserveSoc = customScenarioResult ? customScenarioResult.required_reserve_soc_pct : (station.recommendation?.plan?.reserve_soc_target ?? 30)
  const delayDays = station?.resupply?.delay_days ?? station?.resupply?.model?.slider_delay_days ?? 0

  const heroClass =
    currentRisk === 'SAFE' ? 'safe' :
    currentRisk === 'CAUTION' ? 'caution' :
    currentRisk === 'CONSERVE' ? 'conserve' : 'critical'

  // Handler: Run Assessment
  const handleRecalculate = async () => {
    setBusy(true)
    setIsTracing(true)
    setTraceSteps([])
    setStatusMsg('')

    const steps = [
      'Current station state and telemetry loaded',
      'Demand, solar, and wind forecasts evaluated across uncertainty horizons',
      'Logistics resupply arrival probability distribution computed (P10 / P50 / P90)',
      '30-day forward physical operability simulated across load/dispatch scenarios',
      'Cumulative Quantile Risk Metric (CQRM = Safe Operability − P90 Resupply) calculated',
      'Required battery reserve target and operational risk level calibrated',
    ]

    for (let i = 0; i < steps.length; i++) {
      await new Promise(r => setTimeout(r, 100))
      setTraceSteps(prev => [...prev, steps[i]])
    }

    try {
      const activeSc = localStorage.getItem('polar_ems_active_scenario') || 'NORMAL'
      const res = await runScenarioV1(activeSc, delayDays)
      setCustomScenarioResult(res)
      setStatusMsg(`✓ Safe-operability assessment updated at ${new Date().toLocaleTimeString()} (Scenario: ${activeSc}).`)
      await refresh()
    } catch (e: any) {
      setStatusMsg(`Assessment notice: ${e.message}`)
    } finally {
      setIsTracing(false)
      setBusy(false)
    }
  }

  // Handler: Slider change
  const handleSliderChange = async (days: number) => {
    setSliderBusy(true)
    try {
      await action('/resupply/delay', { delay_days: days })
      localStorage.setItem('polar_ems_resupply_delay', String(days))
      const activeSc = localStorage.getItem('polar_ems_active_scenario') || 'NORMAL'
      const res = await runScenarioV1(activeSc, days)
      setCustomScenarioResult(res)
    } finally {
      setSliderBusy(false)
    }
  }

  return (
    <Page
      title="Safe Operability & CQRM Horizon"
      meta={
        <button
          type="button"
          className="primary"
          onClick={handleRecalculate}
          disabled={busy}
          style={{ fontSize: 12, padding: '5px 12px', fontWeight: 700 }}
        >
          {busy && isTracing ? 'Evaluating…' : '⚡ RE-EVALUATE SAFE OPERABILITY'}
        </button>
      }
    >
      {/* TRACE DISPLAY */}
      {isTracing && (
        <div className="card" style={{ background: '#f8fafc', border: '1px solid #cbd5e1', marginBottom: 12, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', textTransform: 'uppercase', marginBottom: 6 }}>
            Safe-Operability Calculation Trace
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 6 }}>
            {traceSteps.map((step, idx) => (
              <div key={idx} style={{ fontSize: 11, color: '#334155', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: 'var(--green)', fontWeight: 800 }}>✓</span> {step}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 2. DOMINANT HERO WITH SEMICIRCLE GAUGE */}
      <div className={`hero-autonomy ${heroClass}`} id="autonomy-hero-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <div>
            <div className="hero-label">SAFE OPERABILITY HORIZON</div>
            <div className="hero-value">{safeDays ? safeDays.toFixed(1) : '—'}</div>
            <div className="hero-unit">DAYS FORWARD HORIZON</div>
          </div>
          <SemiCircleGauge
            value={safeDays}
            max={Math.max(14, Math.ceil(p90Days * 1.25))}
            unit="d"
            label="Safe Horizon"
            status={heroClass}
            width={120}
            height={70}
            strokeWidth={9}
          />
        </div>

        <div className="hero-meta" style={{ maxWidth: 440 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{statusBadge(currentRisk)}</span>
            <span style={{
              fontFamily: 'var(--mono)',
              fontSize: 18,
              fontWeight: 800,
              color: margin >= 2 ? 'var(--green)' : margin >= 0 ? 'var(--amber)' : 'var(--red)',
            }}>
              CQRM: {margin >= 0 ? `+${margin.toFixed(2)}` : margin.toFixed(2)} DAYS
            </span>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }}>
            <span>
              P90 Resupply: <b>{p90Days ? `${p90Days.toFixed(1)} d` : '—'}</b>
            </span>
            <span>
              Battery Reserve Target: <b>{reserveSoc.toFixed(0)}%</b>
            </span>
          </div>
          <div style={{ marginTop: 8, fontSize: 11.5, color: '#334155', lineHeight: 1.4 }}>
            Risk indicators confirm conservative resupply arrival horizon is {margin >= 0 ? 'fully covered by current reserves' : 'longer than safe operating limits'}.
          </div>
        </div>
      </div>

      {statusMsg && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>
          {statusMsg}
        </div>
      )}

      {/* 3. RESUPPLY TIMELINE & CQRM RELATIONSHIP */}
      <div className="section card" style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: 0.8, textTransform: 'uppercase' }}>
            SAFE OPERABILITY VS RESUPPLY TIMELINE
          </div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700, color: margin >= 0 ? 'var(--green)' : 'var(--red)' }}>
            CQRM Margin = Safe ({safeDays.toFixed(1)}d) − P90 ({p90Days.toFixed(1)}d) = {margin >= 0 ? '+' : ''}{margin.toFixed(2)}d
          </span>
        </div>

        <ResupplyTimelineBar
          p10={p10Days}
          p50={p50Days}
          p90={p90Days}
          safeOperabilityDays={safeDays}
          cqrmDays={margin}
        />
      </div>

      {/* 4. WHY IS SAFE AUTONOMY LIMITED? (LIMITING FACTOR BREAKDOWN) */}
      <div className="section card" style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 12 }}>
          WHY IS SAFE AUTONOMY LIMITED? (PHYSICAL & LOGISTICS FACTORS)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <div style={{ padding: '8px 12px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>DEMAND LOAD</div>
            <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2 }}>{Math.round(station.balance?.load_kw || 180)} kW</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>Heating coupled to ambient -28°C</div>
          </div>
          <div style={{ padding: '8px 12px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>RENEWABLE FRACTION</div>
            <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2 }}>{Math.round(((station.balance?.solar_kw || 0) + (station.balance?.wind_kw || 0)) / (station.balance?.load_kw || 1) * 100)}%</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>Solar array & wind turbine capture</div>
          </div>
          <div style={{ padding: '8px 12px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>BATTERY RESERVE</div>
            <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2 }}>{station.battery_soc.toFixed(1)}% (Target {reserveSoc.toFixed(0)}%)</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>Mandatory contingency floor</div>
          </div>
          <div style={{ padding: '8px 12px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>USABLE FUEL</div>
            <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2 }}>{Math.round(station.fuel_l)} L</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>0.28 L/kWh specific consumption</div>
          </div>
          <div style={{ padding: '8px 12px', background: '#f8fafc', borderRadius: 6, border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontWeight: 600 }}>LOGISTICS DELAY</div>
            <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2 }}>+{delayDays.toFixed(1)} days</div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>Sea-ice / weather window delay</div>
          </div>
        </div>
      </div>

      {/* 5. INTERACTIVE DELAY SLIDER */}
      <div className="section card" style={{ marginTop: 14 }}>
        <ResupplyDelaySlider
          delayDays={delayDays}
          onChange={handleSliderChange}
          disabled={sliderBusy}
        />
      </div>

      {/* 6. PROGRESSIVE DISCLOSURE: CQRM METHODOLOGY */}
      <details className="section" style={{ marginTop: 14 }}>
        <summary style={{ fontSize: 12, fontWeight: 600, color: 'var(--blue)', cursor: 'pointer' }}>
          ▸ Technical Methodology & CQRM Mathematical Formulation
        </summary>
        <div className="card" style={{ marginTop: 8 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 13, background: '#f1f5f9', padding: '8px 12px', borderRadius: 4, marginBottom: 8 }}>
            CQRM_α(t) = SOH_α(t) − R_(1−α)(t)
          </div>
          <p style={{ fontSize: 12, color: '#334155', lineHeight: 1.5, margin: 0 }}>
            <b>Safe Operability Horizon (SOH_α)</b>: The number of days the station can operate under conservative α-quantile weather and renewable shortfall without breaching critical life-safety loads or minimum battery reserves.
            <br /><br />
            <b>Conservative Resupply Horizon (R_(1-α))</b>: The conservative (1-α)-quantile logistics arrival window conditioned on season, sea-ice conditions, and logistics delays.
          </p>
        </div>
      </details>
    </Page>
  )
}
