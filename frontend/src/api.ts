/** Minimal typed API client for the POLAR-EMS backend. */

const BASE = '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

export const get = <T,>(path: string) => req<T>(path)
export const post = <T,>(path: string, body?: unknown) =>
  req<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })

export interface ScenarioV1Response {
  scenario: string
  safe_operability_days: number
  cqrm_days: number
  risk_level: 'SAFE' | 'CAUTION' | 'CONSERVE' | 'CRITICAL' | string
  required_reserve_soc_pct: number
  optimizer_status: string
  safety_status: 'SAFE' | 'UNSAFE' | string
  final_decision: 'ACCEPT_PLAN' | 'REJECT_PLAN' | string
  operating_mode: 'NORMAL' | 'CONSERVATION' | string
  operator_intervention_required: boolean
  resupply_p10_days: number
  resupply_p50_days: number
  resupply_p90_days: number
  resupply_margin_days: number
  recommended_action: string
  reason: string
  violations: any[]
  initial_battery_soc_pct?: number
  final_battery_soc_pct?: number
  initial_fuel_l?: number
  final_fuel_l?: number
  fuel_used_l?: number
  generator_energy_kwh?: number
  renewable_used_kwh?: number
  renewable_curtailed_kwh?: number
  battery_discharge_kwh?: number
  battery_charge_kwh?: number
  first_violation?: { timestamp: string; violations: string[] }
  hourly_plan?: any[]
}

export const runScenarioV1 = (scenario: string, delayDays: number = 0.0) =>
  post<ScenarioV1Response>('/v1/scenario/run', { scenario, delay_days: delayDays })

// ---------------------------------------------------------------- types ----
export interface ResupplyDailyProb {
  day: number
  marginal_probability: number
  cumulative_arrival_probability: number
}

export interface ResupplyModel {
  scheduled_base_days: number
  slider_delay_days: number
  expected_days: number
  conservative_days: number
  optimistic_days: number
  confidence_level: number
  weather_delay_factor_days: number
  weather_impact: string
  primary_uncertainty: string
  daily_distribution: ResupplyDailyProb[]
  data_status: string
}

export interface Autonomy {
  safe_autonomy_days: number
  conservative_days: number
  expected_days: number
  optimistic_days: number
  confidence: number
  failure_probability_before_resupply: number
  next_resupply_days: number
  resupply_conservative_days?: number
  autonomy_margin_days: number
  cqrm_margin_days: number
  status: 'SAFE' | 'CAUTION' | 'CONSERVE' | 'CRITICAL' | string
  interpretation: string
  methodology: string
  assumptions: Record<string, unknown>
  resupply_model?: ResupplyModel
}

export interface BeforeAfterSnapshot {
  battery_kw: number
  diesel_kw: number
  flexible_load_pct: number
  reserve_soc_pct: number
}

export interface BeforeAfterReplan {
  has_changed: boolean
  trigger: string
  trigger_description: string
  before: BeforeAfterSnapshot
  after: BeforeAfterSnapshot
  reason: string
  result: string
  safe_operability_days: number
  margin_days: number
  shortfall_risk_pct: number
  timestamp: number
}

export interface WhatChanged {
  metric: string
  direction: 'up' | 'down' | 'neutral'
  detail: string
}

export interface DemoState {
  active: boolean
  step: number
  total_steps: number
  name: string
  badge?: string
  description?: string
  paused: boolean
}

export interface ModelExecutionState {
  id: string
  name: string
  category: 'predictive' | 'decision'
  loaded: boolean
  feature_validation: 'passed' | 'failed' | 'pending' | string
  execution_status: 'ready' | 'running' | 'complete' | 'degraded' | string
  last_run: string | null
  scenario: string
  feature_count?: number
  model_family?: string
  engine_type?: string
  duration_ms?: number
}

export interface IntelligenceStatus {
  predictive_models: ModelExecutionState[]
  decision_engines: ModelExecutionState[]
  last_pipeline_run: string
  pipeline_status: string
}

export interface Station {
  station: { id: string; name: string; simulation: boolean }
  sim_time_h: number
  fuel_l: number
  fuel_pct: number
  battery_soc: number
  battery_soh: number
  battery_power_kw: number
  generator_running: boolean
  generator_output_kw: number
  generator_failed: boolean
  loads: { critical_kw: number; essential_kw: number; flexible_kw: number; total_kw: number; flexible_shed_pct: number }
  weather: { temperature_c: number; wind_speed_ms: number; solar_irradiance_wm2: number; condition: string }
  scenario: Record<string, boolean>
  connectivity: { internet: string; mqtt: string; cloud: string; sync_queue: number }
  mode: string
  mode_auto: boolean
  resupply: {
    in_days: number
    delay_days?: number
    expected_fuel_l: number
    model?: ResupplyModel
  }
  engines: Record<string, string>
  data_quality: { score: number; issues: string[] }
  balance: { solar_kw: number; wind_kw: number; battery_kw: number; diesel_kw: number; load_kw: number; heating_kw: number }
  autonomy: Autonomy
  latest_forecast: Forecast
  safety: SafetyResult
  awaiting_approval: boolean
  recommendation?: Recommendation
  recommendation_summary: string
  what_changed?: WhatChanged[]
  before_after_replan?: BeforeAfterReplan
  demo_state?: DemoState
  intelligence?: IntelligenceStatus
}

export interface Step {
  start_offset_h: number
  hours: number
  diesel_kw: number
  battery_kw: number
  solar_kw: number
  wind_kw: number
  load_kw: number
  flexible_kw: number
  flexible_pct?: number
}

export interface SafetyResult {
  passed: boolean
  checks: { rule: string; passed: boolean; detail: string }[]
}

export interface Recommendation {
  trigger: string
  status: string
  plan: {
    horizon_h: number
    steps: Step[]
    expected_fuel_l: number
    fuel_consumed_6h_l: number
    fuel_remaining_end_l: number
    expected_end_soc: number
    method: string
    recommendation_summary: string
    reserve_soc_target?: number
    flexible_load_pct?: number
  }
  safety: SafetyResult
  autonomy: Autonomy
  explanations: { question: string; reason_lines: string[]; safety_impact?: string; expected_fuel_saving_l?: number; expected_fuel_use_l?: number }[]
  what_changed?: WhatChanged[]
  before_after_replan?: BeforeAfterReplan
  awaiting_approval: boolean
}

export interface Forecast {
  targets: Record<string, { steps: Record<string, { value: number; lo: number; hi: number }>; model: string }>
  generated_at: number
}

export interface Alert {
  id: number
  ts: number
  severity: string
  code: string
  title: string
  message: string
  acknowledged: number
  occurrences: number
}

export interface SysEvent { ts: number; source: string; event: string; detail: string; status: string }

export interface BaselineComparison {
  baseline: {
    method: string
    fuel_consumed_6h_l: number
    fuel_remaining_end_l: number
    end_soc: number
    renewable_utilised_kw_avg: number
    diesel_avg_kw: number
    critical_load_hours_met: number
    critical_load_hours_total: number
    safe_autonomy_days: number
    resupply_margin_days: number
  }
  polar_ems: {
    method: string
    fuel_consumed_6h_l: number
    fuel_remaining_end_l: number
    end_soc: number
    renewable_utilised_kw_avg: number
    diesel_avg_kw: number
    critical_load_hours_met: number
    critical_load_hours_total: number
    safe_autonomy_days: number
    resupply_margin_days: number
    safety_validated: boolean
  }
  delta: {
    fuel_saved_6h_l: number
    autonomy_gain_days: number
    end_soc_improvement_pct: number
    renewable_utilisation_improvement_kw: number
    early_warning_advantage_h: number
    early_warning_advantage_days: number
  }
  warning_lead_time: {
    baseline_first_warning_h: number
    polar_ems_first_warning_h: number
    baseline_first_warning_days: number
    polar_ems_first_warning_days: number
    early_warning_advantage_h: number
    early_warning_advantage_days: number
  }
  summary: string
}

// ---------------------------------------------------------- Sandbox (Phase 2) --

export interface SandboxExperimentRequest {
  sandbox_session_id?: string
  battery_soc?: number
  battery_soh?: number
  solar_kw?: number
  wind_kw?: number
  station_load_kw?: number
  critical_load_kw?: number
  flexible_load_kw?: number
  fuel_l?: number
  generator_available?: boolean
  resupply_delay_days?: number
  communication_loss?: boolean
  temperature_c?: number
}

export interface InputProvenance {
  value: number | boolean
  source: 'manual_override' | 'model_prediction' | 'scenario_override' | 'simulation_state' | 'cached_value'
  label: string
}

export interface ExecutionTraceStep {
  step: string
  status: 'complete' | 'running' | 'pending' | 'failed'
  detail: string
}

export interface MLInputUsed {
  name: string
  type: string
  active: boolean
}

export interface CandidatePlan {
  id: string
  name: string
  short_name: string
  strategy_type: string
  simple_description: string
  is_recommended: boolean
  confidence: 'STRONGLY PREFERRED' | 'PREFERRED' | 'ALTERNATIVE' | 'NOT RECOMMENDED' | 'UNSAFE' | string
  status_label: 'RECOMMENDED' | 'AVAILABLE' | 'SELECTED' | 'ACTIVE' | 'UNSAFE' | string
  safety_passed: boolean
  safety_checks: Array<{ rule: string; passed: boolean; detail: string }>
  failed_reasons: string[]
  safe_operability_days: number
  cqrm_days: number
  end_soc: number
  reserve_soc_target: number
  fuel_6h_l: number
  fuel_daily_l: number
  critical_coverage_pct: number
  flex_load_pct: number
  flex_reduction_pct: number
  generator_avg_kw: number
  generator_max_kw: number
  battery_avg_kw: number
  optimizer_method: string
  why_recommended: string
  why_not_recommended: string
  ml_inputs_used: MLInputUsed[]
  plan_details?: {
    reserve_soc: number
    flex_mult: number
    steps_count: number
    first_step_diesel_kw: number
    first_step_battery_kw: number
  }
}

export interface RecoveryOption {
  id: string
  label: string
  name: string
  available: boolean
  description: string
  plan: CandidatePlan
  safety_passed: boolean
  safety_checks: Array<{ rule: string; passed: boolean; detail: string }>
  failed_reasons: string[]
  primary_limitation?: string | null
}

export interface SandboxExperimentResponse {
  sandbox_session_id: string
  baseline: {
    battery_soc: number
    battery_soh: number
    fuel_l: number
    safe_operability_days: number
    cqrm_days: number
    risk_level: string
    reserve_target: number
    resupply_delay_days: number
  }
  experiment: {
    battery_soc: number
    battery_soh: number
    fuel_l: number
    safe_operability_days: number
    cqrm_days: number
    risk_level: string
    reserve_target: number
    resupply_delay_days: number
  }
  recommendation: string
  reason: string
  safety: SafetyResult
  autonomy: Autonomy
  candidate_plans?: CandidatePlan[]
  recovery_options?: RecoveryOption[]
  recommended_plan_id?: string | null
  selected_plan_id?: string | null
  feasible_count?: number
  rejected_count?: number
  plans_advisory?: string
  plan_summary: {
    method: string
    expected_fuel_l: number
    reserve_soc_target: number
    flexible_load_pct: number
  }
  input_provenance: Record<string, InputProvenance>
  execution_trace: ExecutionTraceStep[]
  state_version: number
  calculated_at: number
}

export interface SandboxApplyResponse {
  applied: boolean
  applied_plan?: {
    id?: string | null
    name: string
    simple_description: string
  }
  state_version: number
  scenario_id: string
  calculated_at: number
  pipeline_result: {
    status: string
    autonomy_status: string
    cqrm_days: number
    safety_passed: boolean
  }
}

export interface SandboxResetResponse {
  reset: boolean
  state_version: number
  scenario_id: string
  calculated_at: number
  baseline: Record<string, any>
}

export interface ClockToggleResponse {
  simulation_paused: boolean
  status: string
  state_version: number
}

// Sandbox API functions
export const runSandboxExperiment = (req: SandboxExperimentRequest) =>
  post<SandboxExperimentResponse>('/sandbox/experiment', req)

export const selectCandidatePlan = (sandbox_session_id: string, plan_id: string) =>
  post<{ selected_plan_id: string }>('/sandbox/select-plan', { sandbox_session_id, plan_id })

export const applySandboxExperiment = (sandbox_session_id: string, state_version: number, selected_plan_id?: string) =>
  post<SandboxApplyResponse>('/sandbox/apply', { sandbox_session_id, state_version, selected_plan_id })

export const resetSandboxToBaseline = (sandbox_session_id?: string) =>
  post<SandboxResetResponse>('/sandbox/reset', { sandbox_session_id })

export const toggleSimulationClock = () =>
  post<ClockToggleResponse>('/sandbox/clock')
