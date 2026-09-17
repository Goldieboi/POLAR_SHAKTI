import React, { useState } from 'react'
import { useStore } from '../store'
import { Page, statusBadge, ResupplyTimelineBar, EnergyStateChart, ForecastSixHourChart, SemiCircleGauge } from '../components'

interface OverviewPageProps {
  onNavigate?: (page: string) => void
}

/**
 * Overview — Operational Decision Center.
 * Answers immediately: "What do I need to know about the station right now?"
 *
 * Strict Visual Hierarchy:
 * 1. Safe Operability
 * 2. CQRM + Resupply Risk
 * 3. Operating Recommendation
 * 4. Energy State
 * 5. Forecast
 * 6. Key Assets
 */
export const OverviewPage: React.FC<OverviewPageProps> = ({ onNavigate }) => {
  const { station, recommendation } = useStore()
  const [energyRange, setEnergyRange] = useState<'6H' | '12H' | '24H'>('6H')

  if (!station) {
    return (
      <Page title="Station Operations Overview">
        <p style={{ padding: 20, color: 'var(--text-dim)' }}>Loading authoritative station telemetry…</p>
      </Page>
    )
  }

  const a = station.autonomy
  const bal = station.balance
  const rec = recommendation || station.recommendation
  const latestForecast = station.latest_forecast

  // Reactive Autonomy & Resupply Metrics (Bound directly to live backend state)
  const safeDays = a?.safe_autonomy_days ?? 0
  const p10 = a?.optimistic_days ?? (station.resupply?.in_days ? station.resupply.in_days * 0.75 : 6.8)
  const p50 = a?.expected_days ?? station.resupply?.in_days ?? 8.2
  const p90 = a?.next_resupply_days ?? a?.conservative_days ?? (station.resupply?.in_days ? station.resupply.in_days * 1.2 : 10.3)
  const cqrm = a?.cqrm_margin_days ?? a?.autonomy_margin_days ?? (safeDays - p90)
  
  // Status classification from real state
  const autonomyStatus = a?.status || (cqrm >= 2 ? 'SAFE' : cqrm >= 0 ? 'CAUTION' : cqrm >= -2 ? 'CONSERVE' : 'CRITICAL')
  const isSafetyPassed = rec?.safety?.passed ?? station.safety?.passed ?? (cqrm >= 0)

  // Recommendation Action & Rationale
  const nextStep = rec?.plan?.steps?.[0]
  const recommendedAction = 
    autonomyStatus === 'CRITICAL' ? 'EMERGENCY SHEDDING & MAXIMUM GENERATION' :
    autonomyStatus === 'CONSERVE' ? 'CONSERVE ENERGY' :
    autonomyStatus === 'CAUTION' ? 'MAINTAIN CONSERVATIVE DISPATCH' : 'MAINTAIN NORMAL DISPATCH'

  const recSummary = rec?.plan?.recommendation_summary || station.recommendation_summary ||
    (cqrm >= 0
      ? 'Maintain nominal dispatch schedule while preserving battery reserve floor.'
      : 'Resupply margin is constrained; throttle non-critical heating and preserve reserves.')

  const whyExplanation = cqrm >= 0
    ? `CQRM is positive (+${cqrm.toFixed(2)}d) because conservative resupply timing (${p90.toFixed(1)}d) falls safely within the current operating horizon (${safeDays.toFixed(1)}d).`
    : `CQRM is negative (${cqrm.toFixed(2)}d) because conservative resupply timing (${p90.toFixed(1)}d) extends beyond the current safe operating horizon (${safeDays.toFixed(1)}d).`

  const totalRenewables = bal.solar_kw + bal.wind_kw
  const totalDemand = station.loads?.total_kw ?? bal.load_kw

  // Asset Status derivations
  const solarStatus = station.weather.solar_irradiance_wm2 > 20 ? 'ONLINE' : 'DEGRADED'
  const windStatus = station.weather.wind_speed_ms > 2 ? 'ONLINE' : 'STANDBY'
  const batteryStatus = bal.battery_kw > 2 ? 'CHARGING' : bal.battery_kw < -2 ? 'DISCHARGING' : 'HEALTHY'
  const genStatus = station.generator_running ? 'RUNNING' : station.generator_failed ? 'FAILED' : 'AVAILABLE'

  return (
    <Page
      title="Station Overview"
      meta={
        <div className="row" style={{ gap: 8 }}>
          <span className="badge info">LOCAL DECISION PATH ACTIVE</span>
          {statusBadge(autonomyStatus)}
        </div>
      }
    >
      <div className="overview-grid-container">
        {/* ========================================================================= */}
        {/* ROW 1: 4 PRIMARY KPI CARDS                                                */}
        {/* ========================================================================= */}
        <div className="overview-kpis-row">
          {/* Card 1: Safe Operability (VISUALLY DOMINANT WITH COMPACT SEMICIRCLE GAUGE) */}
          <div className={`kpi-card dominant ${autonomyStatus.toLowerCase()}`} id="kpi-safe-operability">
            <div className="kpi-card-header">
              <span className="kpi-card-title">SAFE OPERABILITY</span>
              {statusBadge(autonomyStatus)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div className="kpi-card-body" style={{ marginBottom: 2 }}>
                  <span className="kpi-card-value dominant-val">{safeDays.toFixed(1)}</span>
                  <span className="kpi-card-unit">days</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                  Forward safe operating horizon
                </div>
              </div>
              <SemiCircleGauge
                value={safeDays}
                max={Math.max(14, Math.ceil(p90 * 1.25))}
                unit="d"
                label="Horizon"
                status={autonomyStatus === 'SAFE' ? 'safe' : autonomyStatus === 'CAUTION' ? 'caution' : autonomyStatus === 'CONSERVE' ? 'conserve' : 'critical'}
                width={100}
                height={58}
                strokeWidth={7}
              />
            </div>
            <div className="kpi-card-footer">
              <span>P90 Resupply Horizon: <b style={{ fontFamily: 'var(--mono)', color: '#0f172a' }}>{p90.toFixed(1)} d</b></span>
            </div>
          </div>

          {/* Card 2: CQRM */}
          <div className="kpi-card" id="kpi-cqrm">
            <div className="kpi-card-header">
              <span className="kpi-card-title">CQRM MARGIN</span>
              <span className={`badge ${cqrm >= 2 ? 'safe' : cqrm >= 0 ? 'caution' : cqrm >= -2 ? 'conserve' : 'critical'}`}>
                {cqrm >= 0 ? 'SAFE' : 'DEFICIT'}
              </span>
            </div>
            <div className="kpi-card-body">
              <span className="kpi-card-value" style={{ color: cqrm >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {cqrm >= 0 ? `+${cqrm.toFixed(2)}` : cqrm.toFixed(2)}
              </span>
              <span className="kpi-card-unit">days</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
              Safe Operability − conservative resupply
            </div>
            <div className="kpi-card-footer">
              <span>Risk Status: <b style={{ color: cqrm >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {cqrm >= 2 ? 'Protected' : cqrm >= 0 ? 'Tight Margin' : 'Resupply Deficit'}
              </b></span>
            </div>
          </div>

          {/* Card 3: Station Energy (Compact Multi-metric + Battery SOC Gauge) */}
          <div className="kpi-card" id="kpi-station-energy">
            <div className="kpi-card-header">
              <span className="kpi-card-title">STATION ENERGY</span>
              <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
                {Math.round(totalDemand)} kW load
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div className="energy-metrics-stack">
                <div className="energy-metric-row">
                  <span className="energy-metric-label">Battery SOC</span>
                  <span className="energy-metric-val" style={{ color: 'var(--blue)' }}>
                    {station.battery_soc.toFixed(1)}%
                  </span>
                </div>
                <div className="energy-metric-row">
                  <span className="energy-metric-label">Fuel Reserve</span>
                  <span className="energy-metric-val">
                    {Math.round(station.fuel_l).toLocaleString()} L
                  </span>
                </div>
                <div className="energy-metric-row">
                  <span className="energy-metric-label">Renewable Output</span>
                  <span className="energy-metric-val" style={{ color: 'var(--green)' }}>
                    {Math.round(totalRenewables)} kW
                  </span>
                </div>
              </div>
              <SemiCircleGauge
                value={station.battery_soc}
                unit="%"
                label="SOC"
                width={85}
                height={52}
                strokeWidth={6}
              />
            </div>
            <div className="kpi-card-footer">
              <span>Battery SOH: <b style={{ fontFamily: 'var(--mono)', color: '#0f172a' }}>{station.battery_soh.toFixed(1)}%</b></span>
            </div>
          </div>

          {/* Card 4: Operating Status */}
          <div className="kpi-card" id="kpi-operating-status">
            <div className="kpi-card-header">
              <span className="kpi-card-title">OPERATING STATUS</span>
              <span className="dot" style={{ background: isSafetyPassed ? 'var(--green)' : 'var(--amber)' }} />
            </div>
            <div className="kpi-card-body">
              <span className="kpi-card-value" style={{ fontSize: 24, textTransform: 'uppercase' }}>
                {station.mode || autonomyStatus}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.3, marginBottom: 6 }}>
              {isSafetyPassed ? 'Safety-validated plan active' : 'Safety constraint alert active'}
            </div>
            <div className="kpi-card-footer">
              <span>Control: <b style={{ color: '#0f172a' }}>{station.mode_auto ? 'AUTO DISPATCH' : 'MANUAL'}</b></span>
            </div>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* ROW 2: ENERGY STATE + 6-HOUR FORECAST                                     */}
        {/* ========================================================================= */}
        <div className="overview-two-col">
          {/* Left: Energy State Time-Series */}
          <div className="dashboard-panel" id="panel-energy-state">
            <div className="dashboard-panel-header">
              <div className="dashboard-panel-title">
                <span>ENERGY STATE</span>
              </div>
              <div className="range-switcher">
                {(['6H', '12H', '24H'] as const).map(r => (
                  <button
                    key={r}
                    type="button"
                    className={`range-btn ${energyRange === r ? 'active' : ''}`}
                    onClick={() => setEnergyRange(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <EnergyStateChart
              range={energyRange}
              batterySoc={station.battery_soc}
              loadKw={totalDemand}
              renewableKw={totalRenewables}
            />
          </div>

          {/* Right: 6-Hour Operational Forecast */}
          <div className="dashboard-panel" id="panel-forecast">
            <div className="dashboard-panel-header">
              <div className="dashboard-panel-title">
                <span>FORECAST (NEXT 6 HOURS)</span>
              </div>
              <span className="badge safe" style={{ fontSize: 9 }}>LOCAL INFERENCE</span>
            </div>
            <ForecastSixHourChart
              currentLoad={totalDemand}
              currentSolar={bal.solar_kw}
              currentWind={bal.wind_kw}
              forecastSteps={latestForecast?.targets}
            />
          </div>
        </div>

        {/* ========================================================================= */}
        {/* ROW 3: RESUPPLY RISK + OPERATING RECOMMENDATION                           */}
        {/* ========================================================================= */}
        <div className="overview-two-col">
          {/* Left: Resupply Risk Panel & Timeline Bar */}
          <div className="dashboard-panel" id="panel-resupply-risk">
            <div className="dashboard-panel-header">
              <div className="dashboard-panel-title">
                <span>RESUPPLY RISK & TIMING</span>
              </div>
              <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>
                {station.resupply?.delay_days ? `+${station.resupply.delay_days.toFixed(0)}d delay active` : 'On Schedule'}
              </span>
            </div>

            {/* Compact P10 / P50 / P90 stat boxes */}
            <div className="resupply-stats-row">
              <div className="resupply-stat-box">
                <div className="pct-label">P10 (OPTIMISTIC)</div>
                <div className="pct-val">{p10.toFixed(1)} <span style={{ fontSize: 11, fontWeight: 500 }}>d</span></div>
              </div>
              <div className="resupply-stat-box" style={{ background: '#f0f9ff', borderColor: '#bae6fd' }}>
                <div className="pct-label" style={{ color: 'var(--blue)' }}>P50 (EXPECTED)</div>
                <div className="pct-val" style={{ color: 'var(--blue)' }}>{p50.toFixed(1)} <span style={{ fontSize: 11, fontWeight: 500 }}>d</span></div>
              </div>
              <div className="resupply-stat-box" style={{ background: '#fef2f2', borderColor: '#fecaca' }}>
                <div className="pct-label" style={{ color: '#991b1b' }}>P90 (CONSERVATIVE)</div>
                <div className="pct-val" style={{ color: '#991b1b' }}>{p90.toFixed(1)} <span style={{ fontSize: 11, fontWeight: 500 }}>d</span></div>
              </div>
            </div>

            {/* Visual Resupply Timeline Bar */}
            <div className="resupply-timeline-container">
              <ResupplyTimelineBar
                p10={p10}
                p50={p50}
                p90={p90}
                safeOperabilityDays={safeDays}
                cqrmDays={cqrm}
              />
              <div className="timeline-legend">
                <span>NOW (0d) ─── P10 ─── P50 ─── P90 (Resupply Window)</span>
                <span style={{ fontWeight: 600, color: cqrm >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {cqrm >= 0 ? '✓ Horizon Covers P90' : '⚠ Deficit Before P90'}
                </span>
              </div>
            </div>
          </div>

          {/* Right: Operating Recommendation Panel (Key Decision Support) */}
          <div className={`dashboard-panel rec-decision-panel ${autonomyStatus.toLowerCase()}`} id="panel-recommendation">
            <div className="dashboard-panel-header">
              <div className="dashboard-panel-title">
                <span>OPERATING RECOMMENDATION</span>
              </div>
              <span className={`badge ${isSafetyPassed ? 'safe' : 'critical'}`}>
                {isSafetyPassed ? 'SAFETY: VALIDATED' : 'SAFETY: NOT VALIDATED'}
              </span>
            </div>

            {/* Recommended Action Badge */}
            <div>
              <span className={`rec-action-badge ${autonomyStatus.toLowerCase()}`}>
                {recommendedAction}
              </span>
            </div>

            {/* Explanation & Rationale */}
            <div className="rec-reason-box">
              <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
                {recSummary}
              </div>
              <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                <b>Why:</b> {whyExplanation}
              </div>
            </div>

            {/* Dispatch Plan Summary + Action CTA */}
            <div className="rec-meta-grid">
              <div className="rec-plan-summary">
                <div>Plan: <b>Solar + Wind + Battery + Diesel</b></div>
                <div style={{ marginTop: 2, fontFamily: 'var(--mono)', fontSize: 10 }}>
                  Solar {Math.round(nextStep?.solar_kw ?? bal.solar_kw)}kW · Wind {Math.round(nextStep?.wind_kw ?? bal.wind_kw)}kW · Gen {Math.round(nextStep?.diesel_kw ?? bal.diesel_kw)}kW
                </div>
              </div>

              {onNavigate && (
                <button
                  type="button"
                  className="primary"
                  onClick={() => onNavigate('optimization')}
                  style={{ fontSize: 11, padding: '7px 14px', fontWeight: 700, letterSpacing: 0.4 }}
                >
                  VIEW OPERATING PLAN ▶
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* ROW 4: KEY ASSETS / STATION STATE                                         */}
        {/* ========================================================================= */}
        <div className="dashboard-panel" id="panel-key-assets" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', background: '#fafbfc', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="dashboard-panel-title" style={{ margin: 0 }}>
              <span>KEY ASSETS</span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)' }}>
              Physical Subsystems
            </span>
          </div>

          <table className="assets-table">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Current Output / Level</th>
                <th>Operating Condition</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600, color: '#0f172a' }}>Solar PV Array</td>
                <td>{Math.round(bal.solar_kw)} <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>kW</span></td>
                <td style={{ color: 'var(--text-dim)' }}>
                  Irradiance: {Math.round(station.weather.solar_irradiance_wm2)} W/m²
                </td>
                <td>
                  <span className={`asset-pill ${solarStatus.toLowerCase()}`}>
                    ● {solarStatus}
                  </span>
                </td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: '#0f172a' }}>Wind Turbines</td>
                <td>{Math.round(bal.wind_kw)} <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>kW</span></td>
                <td style={{ color: 'var(--text-dim)' }}>
                  Wind Speed: {station.weather.wind_speed_ms.toFixed(1)} m/s ({station.weather.condition})
                </td>
                <td>
                  <span className={`asset-pill ${windStatus.toLowerCase()}`}>
                    ● {windStatus}
                  </span>
                </td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: '#0f172a' }}>Battery Storage (BESS)</td>
                <td>
                  <span style={{ color: 'var(--blue)', fontWeight: 700 }}>{station.battery_soc.toFixed(1)}%</span> SOC
                </td>
                <td style={{ color: 'var(--text-dim)' }}>
                  SOH: {station.battery_soh.toFixed(1)}% ({bal.battery_kw >= 0 ? `+${Math.round(bal.battery_kw)}` : Math.round(bal.battery_kw)} kW)
                </td>
                <td>
                  <span className={`asset-pill ${batteryStatus.toLowerCase()}`}>
                    ● {batteryStatus}
                  </span>
                </td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: '#0f172a' }}>Diesel Generator</td>
                <td>{Math.round(station.generator_output_kw)} <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>kW</span></td>
                <td style={{ color: 'var(--text-dim)' }}>
                  Fuel Reserve: {Math.round(station.fuel_l).toLocaleString()} L ({station.fuel_pct}%)
                </td>
                <td>
                  <span className={`asset-pill ${genStatus.toLowerCase()}`}>
                    ● {genStatus}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Page>
  )
}
