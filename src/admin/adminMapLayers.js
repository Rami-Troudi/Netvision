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
  if (t < 0.18) return '#ead8bc'
  if (t < 0.38) return '#f6ca85'
  if (t < 0.62) return '#f4aa4e'
  if (t < 0.82) return '#ee7b22'
  return '#c94d12'
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
