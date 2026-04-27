export default function TrendChart({ points = [], label = 'Trend' }) {
  const values = points.length ? points : [4, 6, 5, 8, 7, 9, 6]
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const d = values.map((value, idx) => {
    const x = (idx / Math.max(1, values.length - 1)) * 100
    const y = 44 - ((value - min) / Math.max(1, max - min)) * 34
    return `${idx === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  return (
    <div className="trend-card">
      <div className="section-title">{label}</div>
      <svg viewBox="0 0 100 52" preserveAspectRatio="none"><path className="trend-fill" d={`${d} L100,52 L0,52 Z`} /><path className="trend-line" d={d} /></svg>
    </div>
  )
}
