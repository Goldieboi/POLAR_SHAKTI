import React from 'react'
import { WhatChanged, BeforeAfterReplan, DemoState } from './api'

export const Page: React.FC<{
  title: string
  children: React.ReactNode
  meta?: React.ReactNode
  technicalDisclosure?: boolean
}> = ({ title, children, meta, technicalDisclosure = false }) => (
  <div>
    <div className="page-header-strip">
      <h2>{title}</h2>
      <div className="meta">{meta}</div>
    </div>
    {technicalDisclosure && (
      <span className="sim-technical-note">
        Values shown are simulated for prototype evaluation.
      </span>
    )}
    {children}
  </div>
)

/**
 * SemiCircleGauge: Clean industrial semicircular speedometer-style arc gauge.
 */
export const SemiCircleGauge: React.FC<{
  value: number
  min?: number
  max?: number
  label?: string
  unit?: string
  status?: 'safe' | 'caution' | 'conserve' | 'critical' | 'info' | 'blue'
  width?: number
  height?: number
  strokeWidth?: number
}> = ({
  value,
  min = 0,
  max = 100,
  label,
  unit = '%',
  status,
  width = 120,
  height = 70,
  strokeWidth = 9,
}) => {
  const clamped = Math.max(min, Math.min(max, value))
  const pct = (clamped - min) / (max - min || 1)
  const radius = (width - strokeWidth * 2) / 2
  const cx = width / 2
  const cy = height - 4
  const circumference = Math.PI * radius
  const strokeDashoffset = circumference * (1 - pct)

  // Determine color from status or thresholds
  const color =
    status === 'safe' ? '#16a34a' :
    status === 'caution' ? '#d97706' :
    status === 'conserve' ? '#ea580c' :
    status === 'critical' ? '#dc2626' :
    status === 'blue' || status === 'info' ? '#2563eb' :
    pct >= 0.5 ? '#16a34a' : pct >= 0.25 ? '#d97706' : '#dc2626'

  return (
    <div className="semicircle-gauge-box" style={{ width, height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {/* Background track */}
        <path
          d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Active Arc */}
        {pct > 0 && (
          <path
            d={`M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}`}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
          />
        )}
      </svg>
      <div className="gauge-center-text">
        <span className="gauge-value-num" style={{ color: '#0f172a' }}>
          {typeof value === 'number' ? (value % 1 === 0 ? value : value.toFixed(1)) : value}
          <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-dim)', marginLeft: 1 }}>{unit}</span>
        </span>
        {label && <span className="gauge-value-label">{label}</span>}
      </div>
    </div>
  )
}

export const Kpi: React.FC<{
  label: string
  value: React.ReactNode
  unit?: string
  sub?: string
  hero?: boolean
}> = ({ label, value, unit, sub, hero }) => (
  <div className={`card kpi ${hero ? 'hero' : ''}`}>
    <div className="label">{label}</div>
    <div className="value">
      {value}
      {unit && <span className="unit"> {unit}</span>}
    </div>
    {sub && <div className="sub">{sub}</div>}
  </div>
)

export const Meter: React.FC<{ pct: number; ok?: number; warn?: number }> = ({ pct, ok = 50, warn = 25 }) => {
  const cls = pct >= ok ? 'ok' : pct >= warn ? 'warn' : 'crit'
  return (
    <div className={`meter ${cls}`}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  )
}

/** Lightweight inline SVG line chart (no external chart lib). */
export const LineChart: React.FC<{
  series: { data: number[]; color: string; label: string }[]
  height?: number
  yMin?: number
  yMax?: number
}> = ({ series, height = 160, yMin, yMax }) => {
  const all = series.flatMap(s => s.data).filter(v => Number.isFinite(v))
  if (!all.length) return <div className="chart-svg" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5b6675' }}>no data</div>
  const min = yMin ?? Math.min(...all) * 0.95
  const max = yMax ?? Math.max(...all) * 1.05
  const W = 600, H = height, pad = 18
  const n = Math.max(...series.map(s => s.data.length))
  const x = (i: number) => pad + (i / Math.max(1, n - 1)) * (W - 2 * pad)
  const y = (v: number) => H - pad - ((v - min) / Math.max(1e-9, max - min)) * (H - 2 * pad)
  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }}>
      <line x1={pad} y1={y(0)} x2={W - pad} y2={y(0)} stroke="#edf0f3" />
      <text x={pad} y={12} fontSize="9" fill="#5b6675">{max.toFixed(0)}</text>
      <text x={pad} y={H - 4} fontSize="9" fill="#5b6675">{min.toFixed(0)}</text>
      {series.map((s, si) => (
        <polyline key={si} fill="none" stroke={s.color} strokeWidth="1.5"
          points={s.data.map((v, i) => `${x(i)},${y(Number.isFinite(v) ? v : min)}`).join(' ')} />
      ))}
    </svg>
  )
}

/**
 * Locked status semantics:
 * SAFE     → green
 * CAUTION  → amber
 * CONSERVE → orange/amber
 * CRITICAL → red
 */
export const statusBadge = (status: string) => {
  const s = (status || '').toUpperCase()
  if (['SAFE', 'NORMAL', 'APPROVED', 'ONLINE', 'CONNECTED', 'OPERATIONAL', 'OK'].some(k => s === k || s.startsWith(k))) {
    return <span className="badge safe">{status}</span>
  }
  if (['CAUTION', 'RESUPPLY RISK', 'RESUPPLY_RISK', 'WARNING'].some(k => s.includes(k))) {
    return <span className="badge caution">{status}</span>
  }
  if (['CONSERVE', 'ENERGY_CONSERVATION', 'CONSERVATION', 'THROTTLED'].some(k => s.includes(k))) {
    return <span className="badge conserve">{status}</span>
  }
  if (['CRITICAL', 'EMERGENCY', 'REJECTED', 'OFFLINE', 'FAILED', 'ERROR', 'DISCONNECTED'].some(k => s.includes(k))) {
    return <span className="badge critical">{status}</span>
  }
  return <span className="badge safe">{status}</span>
}

/** Persistent Top-Bar Synthetic Label */
export const SyntheticTopBadge: React.FC = () => (
  <div className="synthetic-top-badge" title="Prototype Evaluation Disclosure">
    <span style={{ color: '#2563eb' }}>●</span> SIMULATION / DEMONSTRATION DATA · NOT CONNECTED TO A REAL ANTARCTIC STATION
  </div>
)

/** Unobtrusive Demo Control Strip */
export const DemoControlStrip: React.FC<{
  demoState: DemoState
  onNext: () => void
  onPrev?: () => void
  onPause: () => void
  onStop: () => void
}> = ({ demoState, onNext, onPrev, onPause, onStop }) => {
  if (!demoState || !demoState.active) return null
  return (
    <div className="demo-control-strip" id="demo-control-strip">
      <div className="demo-title">
        <span className="demo-tag">POLAR-EMS DEMO</span>
        <span className="demo-step-badge">
          Step {demoState.step} / {demoState.total_steps || 7}
        </span>
        <span className="demo-name">{demoState.name}</span>
        {demoState.badge && (
          <span className="badge info" style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
            {demoState.badge}
          </span>
        )}
      </div>
      <div className="demo-actions">
        {onPrev && (
          <button type="button" onClick={onPrev} title="Previous Step">
            ◀ Prev
          </button>
        )}
        <button type="button" onClick={onPause}>
          {demoState.paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button type="button" className="btn-next" onClick={onNext}>
          Next Step ▶
        </button>
        <button type="button" onClick={onStop} style={{ background: 'transparent', borderColor: 'transparent', color: '#94a3b8' }}>
          ✕ Exit Demo
        </button>
      </div>
    </div>
  )
}

/** Interactive Resupply Delay Slider (0 to +7 days, step 1) */
export const ResupplyDelaySlider: React.FC<{
  delayDays: number
  onChange: (days: number) => void
  disabled?: boolean
}> = ({ delayDays, onChange, disabled }) => {
  const [val, setVal] = React.useState(delayDays)

  React.useEffect(() => {
    setVal(delayDays)
  }, [delayDays])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = parseFloat(e.target.value)
    setVal(next)
    onChange(next)
  }

  return (
    <div className="resupply-slider-card">
      <div className="resupply-slider-header">
        <h4>RESUPPLY DELAY</h4>
        <div className="current-delay">
          Current: <b>+{val.toFixed(0)} days</b>
        </div>
      </div>
      <div className="slider-track-wrap">
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>0d</span>
        <input
          id="resupply-delay-slider"
          type="range"
          min="0"
          max="7"
          step="1"
          value={val}
          onChange={handleChange}
          disabled={disabled}
        />
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>+7d</span>
      </div>
      <div className="slider-labels">
        <span>0 days</span>
        <span>+1</span>
        <span>+2</span>
        <span>+3</span>
        <span>+4</span>
        <span>+5</span>
        <span>+6</span>
        <span>+7 days</span>
      </div>
      <div className="slider-impact-note">
        <b>Causality:</b> Moving this slider updates the probabilistic arrival model and directly re-optimizes
        battery reserves and flexible load throttling across the station.
      </div>
    </div>
  )
}

/** "WHAT CHANGED?" Cause -> Effect Component */
export const WhatChangedCard: React.FC<{
  changes: WhatChanged[]
}> = ({ changes }) => {
  if (!changes || !changes.length) return null
  return (
    <div className="what-changed-card" id="what-changed-section">
      <div className="what-changed-header">
        <h4>WHAT CHANGED?</h4>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Live System Diffs</span>
      </div>
      <div className="what-changed-list">
        {changes.map((c, i) => (
          <div key={i} className="what-changed-item">
            <span className={`arrow ${c.direction}`}>
              {c.direction === 'up' ? '↑' : c.direction === 'down' ? '↓' : '→'}
            </span>
            <div className="text">
              <div className="metric-name">{c.metric}</div>
              <div className="metric-detail">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="what-changed-footer">
        These changes caused the operating plan to be dynamically updated.
      </div>
    </div>
  )
}

/** BEFORE / AFTER REPLAN Comparison Component with TRIGGER → PLAN CHANGE → RESULT */
export const BeforeAfterReplanCard: React.FC<{
  data?: BeforeAfterReplan
}> = ({ data }) => {
  if (!data) return null
  const { before, after, reason, trigger_description, result } = data
  return (
    <div className="before-after-card" id="before-after-replan-section">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <h3 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>
          OPTIMIZER DECISION: BEFORE VS AFTER REPLAN
        </h3>
        <span className="badge info">Causality Verified</span>
      </div>

      {/* TRIGGER — What caused the replan */}
      {trigger_description && trigger_description !== 'Nominal conditions' && (
        <div style={{ background: '#fef3c7', borderLeft: '3px solid var(--amber)', padding: '6px 12px',
          borderRadius: '0 4px 4px 0', marginBottom: 10, fontSize: 12, color: '#92400e' }}>
          <b>TRIGGER:</b> {trigger_description}
        </div>
      )}

      <div className="before-after-grid">
        <div className="before-box">
          <h5>BEFORE REPLAN (NOMINAL)</h5>
          <div className="diff-metrics">
            <div className="diff-metric">
              <div className="label">Battery Dispatch</div>
              <div className="val">{before.battery_kw.toFixed(0)} kW</div>
            </div>
            <div className="diff-metric">
              <div className="label">Diesel Gen</div>
              <div className="val">{before.diesel_kw.toFixed(0)} kW</div>
            </div>
            <div className="diff-metric">
              <div className="label">Flexible Load</div>
              <div className="val">{before.flexible_load_pct.toFixed(0)}%</div>
            </div>
            <div className="diff-metric">
              <div className="label">Reserve Floor</div>
              <div className="val">{before.reserve_soc_pct.toFixed(0)}%</div>
            </div>
          </div>
        </div>
        <div className="after-box">
          <h5>AFTER REPLAN (RISK-CONDITIONED)</h5>
          <div className="diff-metrics">
            <div className="diff-metric">
              <div className="label">Battery Dispatch</div>
              <div className="val">{after.battery_kw.toFixed(0)} kW</div>
            </div>
            <div className="diff-metric">
              <div className="label">Diesel Gen</div>
              <div className="val">{after.diesel_kw.toFixed(0)} kW</div>
            </div>
            <div className="diff-metric">
              <div className="label">Flexible Load</div>
              <div className="val" style={{ color: after.flexible_load_pct < 100 ? 'var(--conserve)' : 'inherit' }}>
                {after.flexible_load_pct.toFixed(0)}%
              </div>
            </div>
            <div className="diff-metric">
              <div className="label">Reserve Floor</div>
              <div className="val" style={{ color: after.reserve_soc_pct > 20 ? 'var(--blue)' : 'inherit' }}>
                {after.reserve_soc_pct.toFixed(0)}%
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* RESULT — Outcome of the replan */}
      {result && (
        <div style={{ background: '#f0fdf4', borderLeft: '3px solid var(--green)', padding: '6px 12px',
          borderRadius: '0 4px 4px 0', marginTop: 10, fontSize: 12, color: '#166534' }}>
          <b>RESULT:</b> {result}
        </div>
      )}

      {reason && !result && (
        <div className="replan-reason">
          <b>Reason:</b> {reason}
        </div>
      )}
    </div>
  )
}

/** "WHY NOT JUST USE A NORMAL EMS?" Innovation Panel */
export const WhyPolarEmsPanel: React.FC = () => (
  <div className="why-polar-panel">
    <h3>WHY POLAR-EMS?</h3>
    <div className="why-polar-comparison">
      <div className="why-col">
        <h6>Traditional EMS</h6>
        <div style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)', marginBottom: 6 }}>
          Forecast → Optimize → Dispatch
        </div>
        <p>
          Assumes continuous fuel supply and treats battery reserves as fixed constants. Fails to adjust
          dispatch when weather halts supply ships or blizzards ground logistics.
        </p>
      </div>
      <div className="why-col" style={{ background: '#f0f9ff', borderColor: '#bae6fd' }}>
        <h6 style={{ color: 'var(--blue)' }}>POLAR-EMS</h6>
        <div style={{ fontFamily: 'var(--mono)', color: 'var(--blue)', fontWeight: 600, marginBottom: 6 }}>
          Forecast + Weather Uncertainty + Resupply Uncertainty → Risk-Aware Dispatch → Safety Gate
        </div>
        <p>
          Continuously evaluates cumulative survival margins (CQRM) against weather-gated logistics windows.
          The resupply probability distribution directly constrains optimization and triggers timely conservation.
        </p>
      </div>
    </div>
    <div className="why-key-takeaway">
      The resupply uncertainty is not just displayed; it actively changes the operating decision.
    </div>
  </div>
)

export const fmtTime = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * ResupplyTimelineBar: Operational timeline comparing Safe Operability Horizon against P10–P50–P90 resupply window.
 */
export const ResupplyTimelineBar: React.FC<{
  p10: number
  p50: number
  p90: number
  safeOperabilityDays: number
  cqrmDays: number
}> = ({ p10, p50, p90, safeOperabilityDays, cqrmDays }) => {
  const maxDays = Math.max(14, Math.ceil(Math.max(p90 * 1.25, safeOperabilityDays * 1.15)))
  const W = 520
  const H = 70
  const padL = 36
  const padR = 24
  const usableW = W - padL - padR
  const scale = (d: number) => padL + (Math.max(0, Math.min(maxDays, d)) / maxDays) * usableW

  const xNow = scale(0)
  const xP10 = scale(p10)
  const xP50 = scale(p50)
  const xP90 = scale(p90)
  const xSafe = scale(safeOperabilityDays)

  const isSafe = cqrmDays >= 0
  const safeColor = isSafe ? '#16a34a' : '#dc2626'

  return (
    <div className="resupply-timeline-box" style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {/* Baseline Axis */}
        <line x1={padL} y1={42} x2={W - padR} y2={42} stroke="#cbd5e1" strokeWidth="2" strokeLinecap="round" />

        {/* Major Day Ticks */}
        {[0, Math.round(maxDays / 3), Math.round((maxDays * 2) / 3), maxDays].map(tick => (
          <g key={tick}>
            <line x1={scale(tick)} y1={38} x2={scale(tick)} y2={46} stroke="#94a3b8" strokeWidth="1" />
            <text x={scale(tick)} y={58} fontSize="9" fill="#64748b" textAnchor="middle" fontFamily="var(--mono)">
              {tick}d
            </text>
          </g>
        ))}

        {/* Resupply Window Shaded Area (P10 to P90) */}
        <rect
          x={xP10}
          y={26}
          width={Math.max(2, xP90 - xP10)}
          height={20}
          fill="#eff6ff"
          stroke="#93c5fd"
          strokeWidth="1.5"
          rx="3"
        />

        {/* P10 Marker */}
        <line x1={xP10} y1={24} x2={xP10} y2={48} stroke="#3b82f6" strokeWidth="1.5" />
        <text x={xP10} y={20} fontSize="8.5" fill="#2563eb" fontWeight="700" textAnchor="middle" fontFamily="var(--mono)">
          P10
        </text>

        {/* P50 Median Line */}
        <line x1={xP50} y1={24} x2={xP50} y2={48} stroke="#1d4ed8" strokeWidth="2" strokeDasharray="3,2" />
        <text x={xP50} y={20} fontSize="8.5" fill="#1d4ed8" fontWeight="800" textAnchor="middle" fontFamily="var(--mono)">
          P50 ({p50.toFixed(1)}d)
        </text>

        {/* P90 Conservative Line */}
        <line x1={xP90} y1={24} x2={xP90} y2={48} stroke="#1e40af" strokeWidth="2" />
        <text x={xP90} y={20} fontSize="8.5" fill="#1e40af" fontWeight="800" textAnchor="middle" fontFamily="var(--mono)">
          P90 ({p90.toFixed(1)}d)
        </text>

        {/* Safe Operability Pin / Marker */}
        <g>
          <line x1={xSafe} y1={10} x2={xSafe} y2={50} stroke={safeColor} strokeWidth="2.5" />
          <polygon
            points={`${xSafe - 5},10 ${xSafe + 5},10 ${xSafe},16`}
            fill={safeColor}
          />
          <text
            x={Math.max(padL + 20, Math.min(W - padR - 20, xSafe))}
            y={8}
            fontSize="9"
            fill={safeColor}
            fontWeight="800"
            textAnchor="middle"
            fontFamily="var(--mono)"
          >
            Safe: {safeOperabilityDays.toFixed(1)}d
          </text>
        </g>
      </svg>
    </div>
  )
}

/**
 * EnergyStateChart: Operational multi-series chart showing Battery SOC, Station Load, and Renewable Generation.
 */
export const EnergyStateChart: React.FC<{
  range: '6H' | '12H' | '24H'
  batterySoc: number
  loadKw: number
  renewableKw: number
}> = ({ range, batterySoc, loadKw, renewableKw }) => {
  // Generate sample points based on time range and current live balance
  const pointsCount = range === '6H' ? 7 : range === '12H' ? 13 : 25
  const hoursStep = range === '6H' ? 1 : range === '12H' ? 1 : 1
  
  // Synthetic trend points smoothly anchored to live current state
  const loadPoints: number[] = []
  const renewPoints: number[] = []
  const socPoints: number[] = []

  for (let i = pointsCount - 1; i >= 0; i--) {
    const factor = Math.sin((i / pointsCount) * Math.PI) * 0.15
    const pastLoad = Math.max(80, loadKw * (1 - factor * 0.5 + (Math.sin(i * 1.2) * 0.05)))
    const pastRenew = Math.max(0, renewableKw * (1 + factor * 0.8 - (Math.cos(i * 0.9) * 0.08)))
    const pastSoc = Math.max(20, Math.min(100, batterySoc - (pointsCount - 1 - i) * 0.3 * (pastRenew < pastLoad ? 1 : -0.5)))
    
    loadPoints.push(i === 0 ? loadKw : pastLoad)
    renewPoints.push(i === 0 ? renewableKw : pastRenew)
    socPoints.push(i === 0 ? batterySoc : pastSoc)
  }

  const W = 520
  const H = 140
  const padL = 36
  const padR = 36
  const padT = 14
  const padB = 22
  const usableW = W - padL - padR
  const usableH = H - padT - padB

  // kW scale (0 to max(load, renew) * 1.2)
  const maxKw = Math.max(350, Math.max(...loadPoints, ...renewPoints) * 1.15)
  const scaleX = (idx: number) => padL + (idx / (pointsCount - 1)) * usableW
  const scaleYKw = (val: number) => padT + (1 - val / maxKw) * usableH
  const scaleYSoc = (val: number) => padT + (1 - val / 100) * usableH

  const loadPath = loadPoints.map((v, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleYKw(v)}`).join(' ')
  const renewPath = renewPoints.map((v, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleYKw(v)}`).join(' ')
  const socPath = socPoints.map((v, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleYSoc(v)}`).join(' ')

  return (
    <div style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', background: '#fafbfc', borderRadius: 4, border: '1px solid #e2e8f0' }}>
        {/* Grid lines */}
        {[0, 0.5, 1].map((p, i) => {
          const y = padT + p * usableH
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#edf2f7" strokeWidth="1" />
              <text x={padL - 4} y={y + 3} fontSize="8.5" fill="#94a3b8" textAnchor="end" fontFamily="var(--mono)">
                {Math.round((1 - p) * maxKw)}kW
              </text>
              <text x={W - padR + 4} y={y + 3} fontSize="8.5" fill="#3b82f6" textAnchor="start" fontFamily="var(--mono)">
                {Math.round((1 - p) * 100)}%
              </text>
            </g>
          )
        })}

        {/* Time labels */}
        <text x={padL} y={H - 6} fontSize="8.5" fill="#94a3b8" textAnchor="start" fontFamily="var(--mono)">-{range}</text>
        <text x={padL + usableW / 2} y={H - 6} fontSize="8.5" fill="#94a3b8" textAnchor="middle" fontFamily="var(--mono)">-{range === '6H' ? '3H' : range === '12H' ? '6H' : '12H'}</text>
        <text x={W - padR} y={H - 6} fontSize="8.5" fill="#94a3b8" textAnchor="end" fontFamily="var(--mono)">NOW</text>

        {/* Line paths */}
        <path d={renewPath} fill="none" stroke="#16a34a" strokeWidth="2" />
        <path d={loadPath} fill="none" stroke="#334155" strokeWidth="2" strokeDasharray="4,2" />
        <path d={socPath} fill="none" stroke="#2563eb" strokeWidth="2.5" />

        {/* Current Value Dots */}
        <circle cx={scaleX(pointsCount - 1)} cy={scaleYKw(renewPoints[pointsCount - 1])} r="3.5" fill="#16a34a" />
        <circle cx={scaleX(pointsCount - 1)} cy={scaleYKw(loadPoints[pointsCount - 1])} r="3.5" fill="#334155" />
        <circle cx={scaleX(pointsCount - 1)} cy={scaleYSoc(socPoints[pointsCount - 1])} r="4" fill="#2563eb" />
      </svg>

      {/* Clear Legend */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 3, background: '#2563eb', display: 'inline-block' }} />
          Battery SOC: <b style={{ color: '#0f172a', fontFamily: 'var(--mono)' }}>{batterySoc.toFixed(1)}%</b>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 3, background: '#334155', display: 'inline-block' }} />
          Station Load: <b style={{ color: '#0f172a', fontFamily: 'var(--mono)' }}>{Math.round(loadKw)} kW</b>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 3, background: '#16a34a', display: 'inline-block' }} />
          Renewables: <b style={{ color: '#0f172a', fontFamily: 'var(--mono)' }}>{Math.round(renewableKw)} kW</b>
        </span>
      </div>
    </div>
  )
}

/**
 * ForecastSixHourChart: Clean 6-hour operational forecast curves for Demand, Solar, and Wind.
 */
export const ForecastSixHourChart: React.FC<{
  currentLoad: number
  currentSolar: number
  currentWind: number
  forecastSteps?: Record<string, { steps: Record<string, { value: number }> }>
}> = ({ currentLoad, currentSolar, currentWind, forecastSteps }) => {
  const steps = [1, 2, 3, 4, 5, 6]
  
  // Extract real backend forecast points or project from 1h/6h intervals
  const loadTarget = forecastSteps?.['load_kw']?.steps
  const solarTarget = forecastSteps?.['solar_kw']?.steps
  const windTarget = forecastSteps?.['wind_kw']?.steps

  const getStepVal = (target: Record<string, { value: number }> | undefined, current: number, step: number) => {
    if (!target) return current
    if (target[String(step)]?.value !== undefined) return target[String(step)].value
    const s6 = target['6']?.value ?? current
    const s1 = target['1']?.value ?? current
    // Linear interpolation between step 0 (current), 1, and 6
    if (step === 1) return s1
    return s1 + ((s6 - s1) / 5) * (step - 1)
  }

  const loadVals = [currentLoad, ...steps.map(s => getStepVal(loadTarget, currentLoad, s))]
  const solarVals = [currentSolar, ...steps.map(s => getStepVal(solarTarget, currentSolar, s))]
  const windVals = [currentWind, ...steps.map(s => getStepVal(windTarget, currentWind, s))]

  const W = 520
  const H = 140
  const padL = 36
  const padR = 20
  const padT = 14
  const padB = 22
  const usableW = W - padL - padR
  const usableH = H - padT - padB

  const allVals = [...loadVals, ...solarVals, ...windVals]
  const maxKw = Math.max(300, Math.max(...allVals) * 1.15)
  const scaleX = (idx: number) => padL + (idx / 6) * usableW
  const scaleY = (val: number) => padT + (1 - val / maxKw) * usableH

  const loadPath = loadVals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(v)}`).join(' ')
  const solarPath = solarVals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(v)}`).join(' ')
  const windPath = windVals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i)} ${scaleY(v)}`).join(' ')

  return (
    <div style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', background: '#fafbfc', borderRadius: 4, border: '1px solid #e2e8f0' }}>
        {/* Grid lines */}
        {[0, 0.5, 1].map((p, i) => {
          const y = padT + p * usableH
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#edf2f7" strokeWidth="1" />
              <text x={padL - 4} y={y + 3} fontSize="8.5" fill="#94a3b8" textAnchor="end" fontFamily="var(--mono)">
                {Math.round((1 - p) * maxKw)}kW
              </text>
            </g>
          )
        })}

        {/* Time steps */}
        {['NOW', '+1h', '+2h', '+3h', '+4h', '+5h', '+6h'].map((t, i) => (
          <text key={i} x={scaleX(i)} y={H - 6} fontSize="8.5" fill="#94a3b8" textAnchor="middle" fontFamily="var(--mono)">
            {t}
          </text>
        ))}

        {/* Forecast Lines */}
        <path d={loadPath} fill="none" stroke="#e11d48" strokeWidth="2" strokeDasharray="3,2" />
        <path d={solarPath} fill="none" stroke="#d97706" strokeWidth="2" />
        <path d={windPath} fill="none" stroke="#0284c7" strokeWidth="2" />

        {/* Terminal step dots */}
        <circle cx={scaleX(6)} cy={scaleY(loadVals[6])} r="3.5" fill="#e11d48" />
        <circle cx={scaleX(6)} cy={scaleY(solarVals[6])} r="3.5" fill="#d97706" />
        <circle cx={scaleX(6)} cy={scaleY(windVals[6])} r="3.5" fill="#0284c7" />
      </svg>

      {/* Clear Legend */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 3, background: '#e11d48', display: 'inline-block' }} />
          Load Forecast (+6h): <b style={{ color: '#0f172a', fontFamily: 'var(--mono)' }}>{Math.round(loadVals[6])} kW</b>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 3, background: '#d97706', display: 'inline-block' }} />
          Solar Forecast: <b style={{ color: '#0f172a', fontFamily: 'var(--mono)' }}>{Math.round(solarVals[6])} kW</b>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 3, background: '#0284c7', display: 'inline-block' }} />
          Wind Forecast: <b style={{ color: '#0f172a', fontFamily: 'var(--mono)' }}>{Math.round(windVals[6])} kW</b>
        </span>
      </div>
    </div>
  )
}
