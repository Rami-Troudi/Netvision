export default function Breadcrumb({ scope, onNational, onGovernorate, onDelegation }) {
  return (
    <nav className="breadcrumb" aria-label="Fil d ariane perimetre">
      <button data-testid="crumb-national" aria-current={scope.level === 'national' ? 'page' : undefined} onClick={onNational}>Tunisia</button>
      {scope.governorateName ? <><span>/</span><button data-testid="crumb-governorate" aria-current={scope.level === 'governorate' ? 'page' : undefined} onClick={onGovernorate}>{scope.governorateName}</button></> : <><span>/</span><strong aria-current="page">Vue nationale</strong></>}
      {scope.delegationName ? <><span>/</span><button data-testid="crumb-delegation" aria-current={scope.level === 'delegation' ? 'page' : undefined} onClick={onDelegation}>{scope.delegationName}</button></> : null}
      {scope.selectedCellName ? <><span>/</span><strong aria-current="page">{scope.selectedCellName}</strong></> : null}
    </nav>
  )
}
