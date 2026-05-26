import OverviewPanel from './OverviewPanel'
import PrioritiesPanel from './PrioritiesPanel'
import CellDossierPanel from './CellDossierPanel'
import SimulationPanel from './SimulationPanel'
import AdminDataPanel from './admin/AdminDataPanel'
import AdminServicesPanel from './admin/AdminServicesPanel'
import AdminValidationPanel from './admin/AdminValidationPanel'
import AdminConfigurationPanel from './admin/AdminConfigurationPanel'

export default function CockpitPanel(props) {
  const { activeTab, adminToolsEnabled } = props

  if (activeTab === 'overview') return <OverviewPanel {...props} />
  if (activeTab === 'priorities') return <PrioritiesPanel {...props} />
  if (activeTab === 'cell-dossier') return <CellDossierPanel {...props} />
  if (activeTab === 'simulation') return <SimulationPanel {...props} />

  if (!adminToolsEnabled) return <OverviewPanel {...props} />
  if (activeTab === 'data') return <AdminDataPanel {...props} />
  if (activeTab === 'services') return <AdminServicesPanel {...props} />
  if (activeTab === 'validation') return <AdminValidationPanel {...props} />
  if (activeTab === 'configuration') return <AdminConfigurationPanel {...props} />
  return <OverviewPanel {...props} />
}

