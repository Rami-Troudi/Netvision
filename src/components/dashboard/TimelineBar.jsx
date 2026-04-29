export default function TimelineBar({ timeIndex = [], currentIndex = 0, onChange, onPrev, onNext }) {
  const current = timeIndex[currentIndex]
  const sliderLabel = current?.timestamp ? `Timeline position ${currentIndex + 1} of ${Math.max(1, timeIndex.length)}, ${current.timestamp}` : `Timeline position ${currentIndex + 1} of ${Math.max(1, timeIndex.length)}`
  return (
    <div className="timeline-strip">
      <button data-testid="timeline-prev" onClick={onPrev} disabled={currentIndex <= 0}>Prev</button>
      <label htmlFor="timeline-slider" className="sr-only">Timeline</label>
      <input id="timeline-slider" aria-label="Timeline" aria-valuetext={sliderLabel} type="range" min="0" max={Math.max(0, timeIndex.length - 1)} value={currentIndex} onChange={(e) => onChange(Number(e.target.value))} />
      <button data-testid="timeline-next" onClick={onNext} disabled={currentIndex >= timeIndex.length - 1}>Next</button>
      <strong>{current?.timestamp || 'No time slice'}</strong>
      <span>{timeIndex.length} slices</span>
    </div>
  )
}
