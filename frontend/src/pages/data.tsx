import React, { useEffect, useState } from 'react'
import { get } from '../api'
import { Page } from '../components'

export const DataPage: React.FC = () => {
  const [quality, setQuality] = useState<any>(null)
  const [view, setView] = useState<'overview' | 'readings' | 'quality' | 'telemetry' | 'actions'>('overview')
  const [sensors, setSensors] = useState<string[]>([])
  const [sensor, setSensor] = useState('')
  const [rows, setRows] = useState<any[]>([])
  const [mqtt, setMqtt] = useState<any>(null)
  const [actions, setActions] = useState<any[]>([])

  useEffect(() => {
    get<any>('/sensors/quality').then(setQuality)
    get<{ sensors: string[] }>('/data/sensors').then(r => setSensors(r.sensors))
  }, [])

  useEffect(() => {
    if (view === 'readings') {
      get<{ readings: any[] }>(`/data/readings?limit=200${sensor ? `&sensor=${sensor}` : ''}`)
        .then(r => setRows(r.readings))
    } else if (view === 'telemetry') {
      get<any>('/sensors/mqtt').then(setMqtt)
    } else if (view === 'actions') {
      get<{ actions: any[] }>('/data/operator-actions?limit=100').then(r => setActions(r.actions))
    }
  }, [view, sensor])

  return (
    <Page title="Data & Diagnostics" meta={
      <div className="row">
        {(['overview', 'readings', 'quality', 'telemetry', 'actions'] as const).map(v => (
          <button key={v} className={view === v ? 'primary' : ''} onClick={() => setView(v)}>
            {v === 'overview' ? 'OVERVIEW' : v === 'telemetry' ? 'TELEMETRY HEALTH' : v.toUpperCase()}
          </button>
        ))}
      </div>
    }>
      {view === 'overview' && quality && (
        <div className="card">
          <h3>Data Quality Summary</h3>
          <div className="state-strip" style={{ marginBottom: 8 }}>
            <div className="state-item"><span className="state-label">Score</span><span className="state-value">{quality.score}%</span></div>
            <div className="state-item"><span className="state-label">Samples</span><span className="state-value">{quality.samples}</span></div>
          </div>
          {quality.issues.length > 0 ? (
            <p className="note">{quality.issues.join(' · ')}</p>
          ) : (
            <p className="note">No data-quality issues detected in the recent window.</p>
          )}
          <div className="note" style={{ marginTop: 8 }}>
            Bad data is flagged, never silently hidden. Out-of-range / anomalous readings carry reduced quality scores downstream.
            Use READINGS for raw sensor telemetry, TELEMETRY HEALTH for edge ingestion diagnostics, and ACTIONS for the operator audit trail.
          </div>
        </div>
      )}

      {view === 'readings' && (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <label style={{ margin: 0 }}>Sensor:</label>
            <select value={sensor} onChange={e => setSensor(e.target.value)}>
              <option value="">all</option>
              {sensors.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <span className="note">{rows.length} most recent readings</span>
          </div>
          <table>
            <thead><tr><th>Time</th><th>Sensor</th><th>Value</th><th>Quality</th><th>Source</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{new Date(r.ts * 1000).toLocaleString()}</td>
                  <td>{r.sensor}</td>
                  <td>{typeof r.value === 'number' ? Math.round(r.value * 10) / 10 : r.value} {r.unit}</td>
                  <td style={{ color: r.quality < 0.6 ? 'var(--red)' : r.quality < 0.9 ? 'var(--amber)' : 'var(--green)' }}>
                    {Math.round(r.quality * 100)}%
                  </td>
                  <td>{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'quality' && quality && (
        <div className="card">
          <h3>Data Quality Score: {quality.score}%</h3>
          <p className="note">{quality.issues.length ? quality.issues.join(' · ') : 'No issues detected in the recent window.'}</p>
          {(quality.recent ?? []).length > 0 && (
            <table>
              <thead><tr><th>Time</th><th>Sensor</th><th>Value</th><th>Issue</th><th>Severity</th></tr></thead>
              <tbody>
                {(quality.recent ?? []).map((i: any, k: number) => (
                  <tr key={k}>
                    <td>{new Date(i.ts * 1000).toLocaleTimeString()}</td>
                    <td>{i.sensor}</td><td>{i.value}</td><td>{i.type}</td><td>{i.severity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {view === 'telemetry' && mqtt && (
        <div className="card">
          <h3>Edge Ingestion & Telemetry Bus — {mqtt.mqtt_connected ? 'CONNECTED' : 'DISCONNECTED'} ({mqtt.total_messages} readings ingested)</h3>
          <table>
            <thead><tr><th>Topic</th><th>Status</th><th>Messages</th><th>Last message</th></tr></thead>
            <tbody>
              {mqtt.topics.map((t: any) => (
                <tr key={t.topic}>
                  <td>{t.topic}</td>
                  <td>{t.status}</td>
                  <td>{t.messages}</td>
                  <td>{t.last_message_age_s != null ? `${t.last_message_age_s}s ago` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === 'actions' && (
        <div className="card">
          <h3>Operator Action Audit Trail</h3>
          <table>
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Parameters</th></tr></thead>
            <tbody>
              {actions.map(a => (
                <tr key={a.id}>
                  <td>{new Date(a.ts * 1000).toLocaleString()}</td>
                  <td>{a.actor}</td><td className="plain">{a.action}</td><td>{a.params_json}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  )
}
