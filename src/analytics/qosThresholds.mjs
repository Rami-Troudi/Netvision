export const QOS_THRESHOLDS = Object.freeze({
  prb_high: 75,
  prb_risk_slope: 2,
  throughput_low_mbps: 18,
  throughput_drop_slope_mbps: -1,
  cqi_low: 8,
  cqi_drop_slope: -0.25,
  active_users_rise_slope: 5,
  recurrence_ratio_high: 0.25,
  confidence: Object.freeze({
    medium_min_score: 55,
    high_min_score: 75,
    min_slices_medium: 4,
    min_slices_high: 8,
    missing_ratio_high_max: 0.15,
    missing_ratio_medium_max: 0.35,
  }),
  risk_levels: Object.freeze({
    low_max: 34,
    medium_max: 59,
    high_max: 79,
  }),
})

export function riskLevelFromScore(score) {
  if (score > QOS_THRESHOLDS.risk_levels.high_max) return 'critical'
  if (score > QOS_THRESHOLDS.risk_levels.medium_max) return 'high'
  if (score > QOS_THRESHOLDS.risk_levels.low_max) return 'medium'
  return 'low'
}
