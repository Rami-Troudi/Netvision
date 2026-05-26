const TAB_ALIASES = Object.freeze({
  'peak-hours': 'priorities',
  forecast: 'priorities',
  qos: 'cell-dossier',
  operations: 'simulation',
  system: 'services',
  analytics: 'validation',
  data: 'data',
})

export function normalizeTabId(tabId, fallback = 'overview') {
  if (!tabId) return fallback
  return TAB_ALIASES[tabId] || tabId
}

