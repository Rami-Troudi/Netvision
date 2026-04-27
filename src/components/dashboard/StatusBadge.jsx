export default function StatusBadge({ status = 'stable' }) {
  return <span className={`status-badge status-${status}`}>{status}</span>
}
