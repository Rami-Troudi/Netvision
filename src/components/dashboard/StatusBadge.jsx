import { stateLabelFr } from '../../utils/uiPolicy.mjs'

export default function StatusBadge({ status = 'stable' }) {
  return <span className={`status-badge status-${status}`}>{stateLabelFr(status)}</span>
}
