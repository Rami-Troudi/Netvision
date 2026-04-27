export default function Breadcrumb({ scope, onNational, onGovernorate, onDelegation }) {
  return (
    <nav className="breadcrumb" aria-label="Scope breadcrumb">
      <button onClick={onNational}>Tunisia</button>
      {scope.governorateName ? <><span>/</span><button onClick={onGovernorate}>{scope.governorateName}</button></> : <><span>/</span><strong>National View</strong></>}
      {scope.delegationName ? <><span>/</span><button onClick={onDelegation}>{scope.delegationName}</button></> : null}
      {scope.selectedCellName ? <><span>/</span><strong>{scope.selectedCellName}</strong></> : null}
    </nav>
  )
}
