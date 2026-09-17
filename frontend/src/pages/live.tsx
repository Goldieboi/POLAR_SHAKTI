import React from 'react'
import { useStore } from '../store'
import { Page, Kpi, SemiCircleGauge, LineChart, fmtTime } from '../components'

export const LivePage: React.FC = () => {
  const { station, events } = useStore()
  if (!station) return <Page title="Live Station Monitoring"><p>Loading…</p></Page>

  const bal = station.balance
  const w = station.weather
  const supply = bal.solar_kw + bal.wind_kw + Math.max(0, -bal.battery_kw) + bal.diesel_kw

  return (
    <Page title="Live Physical State" meta={<span className="badge info">{new Date().toLocaleTimeString()}</span>}>
      <div className="grid g4" style={{ marginBottom: 14 }}>
        <Kpi label="Power Demand" value={Math.round(station.loads.total_kw)} unit="kW" />
        <Kpi label="Temperature" value={w.temperature_c.toFixed(1)} unit="°C" sub={w.condition} />
        <Kpi label="Wind Speed" value={w.wind_speed_ms.toFixed(1)} unit="m/s" />
        <Kpi label="Solar Irradiance" value={Math.round(w.solar_irradiance_wm2)} unit="W/m²" />
        <Kpi label="Solar Generation" value={Math.round(bal.solar_kw)} unit="kW" />
        <Kpi label="Wind Generation" value={Math.round(bal.wind_kw)} unit="kW" />
        <Kpi label="Battery Power" value={bal.battery_kw > 0 ? `+${Math.round(bal.battery_kw)}` : Math.round(bal.battery_kw)} unit="kW"
             sub={bal.battery_kw > 0 ? 'charging' : bal.battery_kw < 0 ? 'discharging' : 'idle'} />
        <Kpi label="Generator Output" value={station.generator_running ? Math.round(station.generator_output_kw) : '0'} unit="kW"
             sub={station.generator_running ? 'RUNNING' : station.generator_failed ? 'FAILED' : 'STANDBY'} />
      </div>

      <div className="section grid g2">
        <div className="card">
          <h3 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--text-dim)', marginBottom: 8 }}>
            Energy Balance
          </h3>
          <table>
            <tbody>
              <tr><td className="plain">Total Supply (Solar + Wind + Battery + Diesel)</td><td>{Math.round(supply)} kW</td></tr>
              <tr><td className="plain">Station Load (Critical + Flexible)</td><td>{Math.round(bal.load_kw)} kW</td></tr>
              <tr><td className="plain">Thermal Heating Component</td><td>{Math.round(bal.heating_kw ?? 0)} kW</td></tr>
              <tr><td className="plain">Battery Storage Flow</td><td>{bal.battery_kw >= 0 ? `charging +${Math.round(bal.battery_kw)}` : `discharging ${Math.round(bal.battery_kw)}`} kW</td></tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--text-dim)', marginBottom: 8 }}>
            Storage & Capacity Gauges
          </h3>
          <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '10px 0' }}>
            <SemiCircleGauge
              value={station.battery_soc}
              unit="%"
              label="Battery SOC"
              width={100}
              height={58}
              strokeWidth={8}
            />
            <SemiCircleGauge
              value={station.battery_soh}
              unit="%"
              label="Battery SOH"
              width={100}
              height={58}
              strokeWidth={8}
              status="safe"
            />
            <SemiCircleGauge
              value={station.fuel_pct}
              unit="%"
              label={`Fuel (${Math.round(station.fuel_l).toLocaleString()}L)`}
              width={100}
              height={58}
              strokeWidth={8}
            />
          </div>
        </div>
      </div>

      <details className="section">
        <summary>Live Event Stream</summary>
        <div className="card">
          <div className="eventlog">
            {events.slice(0, 20).map((e, i) => (
              <div className="ev" key={i}>
                <span className="ts">{fmtTime(e.ts)}</span>
                <span><b>{e.source}</b> — {e.event}</span>
              </div>
            ))}
          </div>
        </div>
      </details>

      <details className="section">
        <summary>Load Trend (server-side)</summary>
        <div className="card">
          <LiveTrend />
        </div>
      </details>
    </Page>
  )
}

const LiveTrend: React.FC = () => {
  const [data, setData] = React.useState<number[]>([])
  React.useEffect(() => {
    let stop = false
    const pull = async () => {
      try {
        const res = await fetch('/api/data/readings?sensor=load_kw&limit=60').then(r => r.json())
        if (!stop) setData(res.readings.map((r: any) => r.value).reverse())
      } catch { /* keep last */ }
    }
    pull()
    const iv = setInterval(pull, 5000)
    return () => { stop = true; clearInterval(iv) }
  }, [])
  return <LineChart series={[{ data, color: 'var(--blue)', label: 'load kW' }]} />
}
