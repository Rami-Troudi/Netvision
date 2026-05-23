const SPEED_OPTIONS = [
  { id: 3000, label: '0.5x' },
  { id: 1500, label: '1x' },
  { id: 750, label: '2x' },
  { id: 350, label: '4x' },
  { id: 200, label: '8x' },
]

export default function TimelineBar({
  timeIndex = [],
  currentIndex = 0,
  onChange,
  onPrev,
  onNext,
  isPlaying = false,
  speedMs = 1500,
  onTogglePlay,
  onSpeedChange,
  onStartFrom = () => {},
}) {
  const current = timeIndex[currentIndex]
  const sliderLabel = current?.timestamp ? `Position temporelle ${currentIndex + 1} sur ${Math.max(1, timeIndex.length)}, ${current.timestamp}` : `Position temporelle ${currentIndex + 1} sur ${Math.max(1, timeIndex.length)}`
  return (
    <div className="timeline-strip">
      <button data-testid="timeline-prev" onClick={onPrev} disabled={currentIndex <= 0}>Precedent</button>
      <label htmlFor="timeline-slider" className="sr-only">Chronologie</label>
      <input id="timeline-slider" aria-label="Chronologie" aria-valuetext={sliderLabel} type="range" min="0" max={Math.max(0, timeIndex.length - 1)} value={currentIndex} onChange={(e) => onChange(Number(e.target.value))} />
      <button data-testid="timeline-play" onClick={onTogglePlay} disabled={!timeIndex.length}>{isPlaying ? 'Pause' : 'Lecture'}</button>
      <label htmlFor="timeline-speed" className="sr-only">Vitesse de lecture</label>
      <select id="timeline-speed" data-testid="timeline-speed" aria-label="Vitesse de lecture" value={speedMs} onChange={(e) => onSpeedChange(Number(e.target.value))}>
        {SPEED_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <label htmlFor="timeline-start-mode" className="sr-only">Demarrer depuis</label>
      <select id="timeline-start-mode" data-testid="timeline-start-mode" aria-label="Demarrer depuis" defaultValue="current" disabled={!timeIndex.length} onChange={(e) => onStartFrom(e.target.value)}>
        <option value="current">Depuis cette tranche</option>
        <option value="start">Depuis le debut</option>
        <option value="end">Depuis la derniere tranche</option>
      </select>
      <strong>{current?.timestamp || 'Aucune tranche'}</strong>
      <span>{timeIndex.length} tranches</span>
    </div>
  )
}
