import { useState, useEffect } from 'react'
import { fetchJson } from '../admin/adminData.js'

export function buildSystemEndpointChecks({ adminToolsEnabled = false, activeTab = 'overview', hasActiveSimulationJob = false } = {}) {
  const shouldCheckAdminHealth = Boolean(adminToolsEnabled || activeTab === 'services')
  const shouldCheckJobsHealth = Boolean(adminToolsEnabled || activeTab === 'simulation' || hasActiveSimulationJob)
  const checks = []
  if (shouldCheckAdminHealth) {
    checks.push({ name: 'data', url: '/api/data/stats.json' })
    checks.push({ name: 'backend', url: '/api/backend-health' })
  }
  if (shouldCheckJobsHealth) checks.push({ name: 'jobsHealth', url: '/api/jobs-health' })
  return checks
}

export function useSystemEndpoints(options = {}) {
  const [endpointStatus, setEndpointStatus] = useState({})
  const [workerState, setWorkerState] = useState('ready')
  const [jobsHealth, setJobsHealth] = useState(null)
  const { adminToolsEnabled = false, activeTab = 'overview', hasActiveSimulationJob = false } = options

  useEffect(() => {
    let cancelled = false
    async function probeEndpoints() {
      const plannedChecks = buildSystemEndpointChecks({ adminToolsEnabled, activeTab, hasActiveSimulationJob })
      if (!plannedChecks.length) {
        if (!cancelled) {
          setEndpointStatus({})
          setJobsHealth(null)
          setWorkerState('ready')
        }
        return
      }
      async function check(name, url) {
        try {
          const res = await fetch(url, { cache: 'no-store' })
          const payload = await res.json().catch(() => ({}))
          const reachable = res.ok
          const degraded = payload?.available === false || payload?.ready === false
          return [name, { wired: true, reachable, degraded, detail: payload?.detail || payload?.reason || payload?.error || '', payload }]
        } catch (err) {
          return [name, { wired: true, reachable: false, degraded: true, detail: err.message || String(err) }]
        }
      }
      const pairs = await Promise.all(plannedChecks.map((item) => check(item.name, item.url)))
      if (!cancelled) {
        const next = Object.fromEntries(pairs)
        setEndpointStatus(next)
        setJobsHealth(next.jobsHealth?.payload || null)
        setWorkerState(next.jobsHealth ? (next.jobsHealth.reachable && !next.jobsHealth.degraded ? 'ready' : (next.jobsHealth.detail || 'unavailable')) : 'ready')
      }
    }
    probeEndpoints()
    const timer = window.setInterval(probeEndpoints, 60000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [adminToolsEnabled, activeTab, hasActiveSimulationJob])

  return { endpointStatus, workerState, jobsHealth }
}

export function usePeakHours({ data, scope, busyMetric, dataMode }) {
  const [peakRows, setPeakRows] = useState([])
  const [peakPayload, setPeakPayload] = useState({ available: false, rows: [], summary: null, reason: '' })

  useEffect(() => {
    if (!data) return
    let cancelled = false
    const params = new URLSearchParams({ metric: busyMetric, limit: '80' })
    if (scope.level === 'national') params.set('group_by', 'governorate')
    else if (scope.level === 'governorate') { params.set('group_by', 'delegation'); params.set('gov_id', scope.governorateId || '') }
    else if (scope.level === 'delegation') { params.set('group_by', 'site'); params.set('deleg_id', scope.delegationId || '') }
    else if (scope.level === 'cell') { params.set('group_by', 'cell'); params.set('cell_name', scope.selectedCellName || '') }
    fetchJson(`/api/peak-hours?${params.toString()}`)
      .then((payload) => { if (!cancelled) { setPeakPayload(payload); setPeakRows(payload.rows || []) } })
      .catch((err) => { if (!cancelled) setPeakPayload({ available: false, rows: [], summary: null, reason: err.message || String(err) }) })
    return () => { cancelled = true }
  }, [data, scope.level, scope.governorateId, scope.delegationId, scope.selectedCellName, busyMetric, dataMode])

  return { peakRows, peakPayload }
}
