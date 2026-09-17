import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { get, post, Station, Recommendation, Alert, SysEvent, toggleSimulationClock } from './api'

/** Shared live system state — every page reads from this one store,
 *  mirroring the backend's shared SystemState (Phase 2 upgrade).
 *
 *  Phase 2: single authoritative state response -> global React store -> all pages update.
 *  No page-specific polling. stale_version protection prevents race conditions.
 */

interface Store {
  station: Station | null
  recommendation: Recommendation | null
  alerts: Alert[]
  events: SysEvent[]
  connected: boolean
  stateVersion: number
  simulationPaused: boolean
  refresh: () => Promise<void>
  action: (path: string, body?: unknown) => Promise<any>
  toggleClock: () => Promise<void>
}

const Ctx = createContext<Store>(null as any)

export const useStore = () => useContext(Ctx)

export const StoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [station, setStation] = useState<Station | null>(null)
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [events, setEvents] = useState<SysEvent[]>([])
  const [connected, setConnected] = useState(true)
  const [stateVersion, setStateVersion] = useState(0)
  const [simulationPaused, setSimulationPaused] = useState(true)

  // In-flight request de-duplication: ignore stale responses
  const requestIdRef = useRef(0)

  const refresh = useCallback(async () => {
    const thisRequest = ++requestIdRef.current
    try {
      const [s, r, a, e] = await Promise.all([
        get<Station>('/station'),
        get<Recommendation>('/optimization/latest'),
        get<{ alerts: Alert[] }>('/alerts'),
        get<{ events: SysEvent[] }>('/events?limit=60'),
      ])

      // Stale response protection: only apply if this is still the latest request
      if (thisRequest !== requestIdRef.current) return

      // Version check: never overwrite newer state with older
      const incomingVersion = (s as any).state_version || 0
      if (incomingVersion > 0 && incomingVersion < stateVersion) return

      setStation(s)
      setRecommendation(r)
      setAlerts(a.alerts)
      setEvents(e.events)
      setConnected(true)
      if (incomingVersion > 0) setStateVersion(incomingVersion)
      if ((s as any).simulation_paused !== undefined) {
        setSimulationPaused((s as any).simulation_paused)
      }
    } catch {
      if (thisRequest === requestIdRef.current) {
        setConnected(false)
      }
    }
  }, [stateVersion])

  const action = useCallback(async (path: string, body?: unknown) => {
    const res = await post(path, body)
    await refresh()
    return res
  }, [refresh])

  const toggleClock = useCallback(async () => {
    try {
      const res = await toggleSimulationClock()
      setSimulationPaused(res.simulation_paused)
      setStateVersion(res.state_version)
    } catch (e) {
      console.error('Failed to toggle simulation clock:', e)
    }
  }, [])

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 3000)
    return () => clearInterval(iv)
  }, [refresh])

  return (
    <Ctx.Provider value={{ station, recommendation, alerts, events, connected, stateVersion, simulationPaused, refresh, action, toggleClock }}>
      {children}
    </Ctx.Provider>
  )
}
