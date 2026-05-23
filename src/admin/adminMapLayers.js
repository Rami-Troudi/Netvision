export function metricColor(value, metricMode) {
  const v = Number(value) || 0
  let t = 0
  if (metricMode === 'avg_throughput' || metricMode === 'avg_cqi') {
    const max = metricMode === 'avg_cqi' ? 12 : 35
    t = 1 - Math.min(1, v / max)
  } else if (metricMode === 'lost_traffic' || metricMode === 'recoverable_traffic') {
    t = Math.min(1, v / 100)
  } else {
    t = Math.min(1, v / 100)
  }
  // Continuous yellow->orange->red gradient for finer congestion readability.
  const clamped = Math.max(0, Math.min(1, t))
  const start = [238, 224, 198]
  const mid = [244, 171, 78]
  const end = [185, 58, 18]
  const blend = (a, b, ratio) => Math.round(a + (b - a) * ratio)
  const ratio = clamped <= 0.65 ? clamped / 0.65 : (clamped - 0.65) / 0.35
  const from = clamped <= 0.65 ? start : mid
  const to = clamped <= 0.65 ? mid : end
  const r = blend(from[0], to[0], ratio)
  const g = blend(from[1], to[1], ratio)
  const b = blend(from[2], to[2], ratio)
  return `rgb(${r}, ${g}, ${b})`
}

export function boundsForFeature(feature) {
  const coords = []
  const walk = (arr) => {
    if (!Array.isArray(arr)) return
    if (typeof arr[0] === 'number' && typeof arr[1] === 'number') coords.push(arr)
    else arr.forEach(walk)
  }
  walk(feature?.geometry?.coordinates)
  if (!coords.length) return [[7.4, 30.2], [11.7, 37.6]]
  const xs = coords.map((c) => c[0])
  const ys = coords.map((c) => c[1])
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]]
}

export function featureCenter(feature) {
  const [[minX, minY], [maxX, maxY]] = boundsForFeature(feature)
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}
