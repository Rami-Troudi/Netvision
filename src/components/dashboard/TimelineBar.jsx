export default function TimelineBar({ timeIndex = [], currentIndex = 0, onChange, onPrev, onNext }) {
  const current = timeIndex[currentIndex]
  return (
    <div className="timeline-strip">
      <button onClick={onPrev} disabled={currentIndex <= 0}>Prev</button>
      <input type="range" min="0" max={Math.max(0, timeIndex.length - 1)} value={currentIndex} onChange={(e) => onChange(Number(e.target.value))} />
      <button onClick={onNext} disabled={currentIndex >= timeIndex.length - 1}>Next</button>
      <strong>{current?.timestamp || 'No time slice'}</strong>
      <span>{timeIndex.length} slices</span>
    </div>
  )
}
