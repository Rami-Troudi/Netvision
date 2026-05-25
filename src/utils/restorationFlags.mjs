const DEFAULT_FLAGS = Object.freeze({
  forecast: true,
  drift: true,
  noc_views: true,
  analytics: true,
  ux_comfort: true,
})

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const normalized = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

export function getRestorationFlags() {
  if (typeof window === 'undefined') {
    return {
      forecast: parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_FORECAST, DEFAULT_FLAGS.forecast),
      drift: parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_DRIFT, DEFAULT_FLAGS.drift),
      noc_views: parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_NOC_VIEWS, DEFAULT_FLAGS.noc_views),
      analytics: parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_ANALYTICS, DEFAULT_FLAGS.analytics),
      ux_comfort: parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_UX_COMFORT, DEFAULT_FLAGS.ux_comfort),
    }
  }
  const params = new URLSearchParams(window.location.search)
  const overrides = {
    forecast: params.get('ff_forecast'),
    drift: params.get('ff_drift'),
    noc_views: params.get('ff_noc_views'),
    analytics: params.get('ff_analytics'),
    ux_comfort: params.get('ff_ux_comfort'),
  }
  return {
    forecast: parseBool(overrides.forecast, parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_FORECAST, DEFAULT_FLAGS.forecast)),
    drift: parseBool(overrides.drift, parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_DRIFT, DEFAULT_FLAGS.drift)),
    noc_views: parseBool(overrides.noc_views, parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_NOC_VIEWS, DEFAULT_FLAGS.noc_views)),
    analytics: parseBool(overrides.analytics, parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_ANALYTICS, DEFAULT_FLAGS.analytics)),
    ux_comfort: parseBool(overrides.ux_comfort, parseBool(process.env.NEXT_PUBLIC_NETVISION_FLAG_UX_COMFORT, DEFAULT_FLAGS.ux_comfort)),
  }
}

