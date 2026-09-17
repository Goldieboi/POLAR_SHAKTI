import React, { useState } from 'react'
import { useStore } from '../store'
import { Page, statusBadge, ResupplyDelaySlider, ResupplyTimelineBar } from '../components'
import { post, runScenarioV1, ScenarioV1Response } from '../api'

export const ResupplyPage: React.FC = () => {
  const { station, action, refresh } = useStore()
  const [busy, setBusy] = useState(false)
  const [delayScenarioResult, setDelayScenarioResult] = useState<ScenarioV1Response | null>(null)
  const [selectedDelay, setSelectedDelay] = useState<number>(0)

  if (!station) return <Page title="Resupply Logistics"><p>Loading…</p></Page>

  const a = station.autonomy
  const model = station.resupply?.model
  const currentDelay = station.resupply?.delay_days ?? model?.slider_delay_days ?? selectedDelay

  const safeDays = delayScenarioResult ? delayScenarioResult.safe_operability_days : a?.safe_autonomy_days ?? 10.79
  const p10 = delayScenarioResult ? delayScenarioResult.resupply_p10_days : 6.78 + currentDelay
  const p50 = delayScenarioResult ? delayScenarioResult.resupply_p50_days : 8.23 + currentDelay
  const p90 = delayScenarioResult ? delayScenarioResult.resupply_p90_days : 10.30 + currentDelay
  const margin = delayScenarioResult ? delayScenarioResult.cqrm_days : safeDays - p90
  const risk = delayScenarioResult ? delayScenarioResult.risk_level : margin > 2 ? 'SAFE' : margin > 0 ? 'CAUTION' : margin > -2 ? 'CONSERVE' : 'CRITICAL'
  const decision = delayScenarioResult ? delayScenarioResult.final_decision : margin > 0 ? 'ACCEPT_PLAN' : 'REJECT_PLAN'

  const heroClass =
    risk === 'SAFE' ? 'safe' :
    risk === 'CAUTION' ? 'caution' :
    risk === 'CONSERVE' ? 'conserve' : 'critical'

  // Run simulation with specific delay
  const handleSimulateDelay = async (days: number) => {
    setBusy(true)
    setSelectedDelay(days)
    try {
      await action('/resupply/delay', { delay_days: days })
      localStorage.setItem('polar_ems_resupply_delay', String(days))
      const scName = days === 4 ? 'RESUPPLY_DELAY_4D' : 'NORMAL'
      const res = await runScenarioV1(scName, days)
      setDelayScenarioResult(res)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page
      title="Resupply Logistics & Uncertainty Modeling"
      technicalDisclosure={true}
      meta={statusBadge(risk)}
    >
      {/* 1. QUESTION-ORIENTED SUMMARY */}
      <div className="card" style={{ borderLeft: margin < 0 ? '4px solid var(--danger)' : '4px solid var(--blue)', marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 13, color: margin < 0 ? 'var(--danger)' : 'var(--blue)', fontWeight: 700 }}>
          WHEN CAN RESUPPLY REALISTICALLY ARRIVE?
        </h3>
        <p style={{ fontSize: 13, color: '#334155', margin: 0, lineHeight: 1.5 }}>
          {margin < 0
            ? `CONVOY AT RISK: With a +${currentDelay.toFixed(0)}d delay, conservative P90 resupply is delayed to ${p90.toFixed(2)} days, exceeding safe operability by ${Math.abs(margin).toFixed(2)} days. Operating Plan is ${decision}.`
            : `CONVOY ON SCHEDULE: Resupply is projected to arrive within the safe operability window (${safeDays.toFixed(2)}d safe vs ${p90.toFixed(2)}d P90). Operating Plan is ${decision}.`}
        </p>
      </div>

      {/* 2. HERO CARD + TIMELINE */}
      <div className={`hero-autonomy ${heroClass}`} style={{ marginBottom: 14 }}>
        <div>
          <div className="hero-label">P50 / P90 RESUPPLY WINDOW</div>
          <div className="hero-value">{p50.toFixed(1)} – {p90.toFixed(1)}</div>
          <div className="hero-unit">DAYS ETA</div>
        </div>
        <div className="hero-meta">
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>{statusBadge(risk)}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 800,
              color: margin >= 2 ? 'var(--green)' : margin >= 0 ? 'var(--amber)' : 'var(--red)' }}>
              {margin >= 0 ? `+${margin.toFixed(2)}` : margin.toFixed(2)}d CQRM Margin
            </span>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }}>
            <span>Safe Operability Horizon: <b>{safeDays.toFixed(2)} days</b></span>
            <span>Decision: <b style={{ color: decision === 'ACCEPT_PLAN' ? 'var(--green)' : 'var(--danger)' }}>{decision}</b></span>
          </div>
        </div>
      </div>

      {/* VISUAL RESUPPLY TIMELINE BAR */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-dim)', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8 }}>
          PROBABILISTIC RESUPPLY ARRIVAL TIMELINE VS SAFE HORIZON
        </div>
        <ResupplyTimelineBar
          p10={p10}
          p50={p50}
          p90={p90}
          safeOperabilityDays={safeDays}
          cqrmDays={margin}
        />
      </div>

      {/* 3. SIMULATION QUICK ACTION BUTTONS */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h4 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-dim)', margin: '0 0 10px' }}>
          SIMULATE LOGISTICS DELAYS (TRIGGER REAL BACKEND REPLAN)
        </h4>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={currentDelay === 0 ? 'primary' : ''}
            disabled={busy}
            onClick={() => handleSimulateDelay(0)}
            style={{ fontWeight: 600, padding: '7px 16px' }}
          >
            Reset (0d Delay)
          </button>
          <button
            type="button"
            className={currentDelay === 1 ? 'primary' : ''}
            disabled={busy}
            onClick={() => handleSimulateDelay(1)}
            style={{ fontWeight: 600, padding: '7px 16px' }}
          >
            Simulate +1 Day Delay
          </button>
          <button
            type="button"
            className={currentDelay === 2 ? 'primary' : ''}
            disabled={busy}
            onClick={() => handleSimulateDelay(2)}
            style={{ fontWeight: 600, padding: '7px 16px' }}
          >
            Simulate +2 Days Delay
          </button>
          <button
            type="button"
            className={currentDelay === 4 ? 'danger' : ''}
            disabled={busy}
            onClick={() => handleSimulateDelay(4)}
            style={{ fontWeight: 700, padding: '7px 16px' }}
          >
            ⚡ Simulate +4 Days Delay (Stress Case)
          </button>
        </div>
      </div>

      {/* 4. VISUAL TIMELINE CARD */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h4 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-dim)', margin: '0 0 12px' }}>
          OPERATIONAL HORIZON & RESUPPLY ARRIVAL TIMELINE
        </h4>
        <div style={{ background: '#f8fafc', padding: 16, borderRadius: 6, position: 'relative' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
            <span>NOW (Day 0)</span>
            <span style={{ color: 'var(--blue)' }}>P10 Resupply ({p10.toFixed(1)}d)</span>
            <span style={{ color: 'var(--green)' }}>P50 Resupply ({p50.toFixed(1)}d)</span>
            <span style={{ color: 'var(--amber)' }}>P90 Resupply ({p90.toFixed(1)}d)</span>
            <span style={{ color: margin >= 0 ? 'var(--blue)' : 'var(--danger)' }}>Safe Operability ({safeDays.toFixed(1)}d)</span>
          </div>

          <div style={{ height: 16, background: '#e2e8f0', borderRadius: 8, position: 'relative', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, (safeDays / 16.0) * 100)}%`,
                background: margin >= 0 ? 'var(--blue)' : 'var(--danger)',
                opacity: 0.75,
                borderRadius: 8
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 14, fontSize: 12 }}>
            <div className="card" style={{ padding: 10 }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>P10 RESUPPLY (BEST-CASE)</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--blue)', marginTop: 2 }}>{p10.toFixed(2)} d</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Optimal ice conditions</div>
            </div>
            <div className="card" style={{ padding: 10 }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>P50 RESUPPLY (MEDIAN)</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)', marginTop: 2 }}>{p50.toFixed(2)} d</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Expected convoy speed</div>
            </div>
            <div className="card" style={{ padding: 10 }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>P90 RESUPPLY (CONSERVATIVE)</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--amber)', marginTop: 2 }}>{p90.toFixed(2)} d</div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>Weather/pressure delay buffer</div>
            </div>
            <div className="card" style={{ padding: 10, borderLeft: margin >= 0 ? '3px solid var(--green)' : '3px solid var(--danger)' }}>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>CQRM DEFICIT / SURPLUS</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: margin >= 0 ? 'var(--green)' : 'var(--danger)', marginTop: 2 }}>
                {margin >= 0 ? `+${margin.toFixed(2)}` : margin.toFixed(2)} d
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{margin >= 0 ? 'Safe margin' : 'Intervention needed'}</div>
            </div>
          </div>
        </div>
      </div>

      {/* 5. INTERACTIVE SLIDER */}
      <div className="section">
        <ResupplyDelaySlider
          delayDays={currentDelay}
          onChange={(days) => handleSimulateDelay(days)}
        />
      </div>
    </Page>
  )
}
