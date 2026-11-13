import type { WaferMap } from '../../api/types'
import { fmt } from '../../format'
import { unitWord } from '../../terms'

interface Props {
  data: WaferMap
}

/* Wafer details beside the map: identity, context and headline metrics in one
   card, then where the data came from. Pure presentation. The space below is
   intentionally free for future panels. */
export function WaferSidebar({ data }: Props) {
  return (
    <aside className="wafer-sidebar" aria-label="Wafer details">
      <WaferDetailsCard data={data} />
      <WaferSourceCard data={data} />
    </aside>
  )
}

function WaferDetailsCard({ data }: Props) {
  const s = data.summary
  const unit = unitWord(s.unit, data.feature_label)
  const codes = data.status_counts.filter((c) => c.status !== 'Good').length
  return (
    <section className="card" aria-label="Wafer metrics">
      <h2 className="card-title wafer-id" data-testid="wafer-title">{data.sample_id}</h2>
      <dl className="facts">
        <dt>CollectionPlan</dt><dd data-testid="collection-plan">{data.file.collection_plan}</dd>
        <dt>Product</dt><dd>{data.product}</dd>
        {data.product_group && (<><dt>Group</dt><dd>{data.product_group}</dd></>)}
        <dt>Layout</dt>
        <dd data-testid="layout-pill" className={data.layout ? undefined : 'status-alarm'}>
          {data.layout ? `${data.layout.name} · rev ${data.layout.revision}` : 'none'}
          {data.layout && <span className="cell-muted"> (by {data.layout.matched_by === 'product' ? 'product' : 'group'})</span>}
        </dd>
        <dt>Orientation</dt><dd>Notch ↓ (assumed)</dd>
        <dt>Yield</dt>
        <dd>
          <strong data-testid="kpi-yield">{s.yield_pct === null ? 'N/A' : `${fmt(s.yield_pct, 1)}%`}</strong>
          <span className="cell-muted"> {fmt(s.good)} good of {fmt(s.total)} {unit}{s.farm_dies ? ', farm dies excluded' : ''}</span>
        </dd>
        <dt>Scrapped</dt>
        <dd><strong>{fmt(s.bad)}</strong><span className="cell-muted"> {unit}, {fmt(codes)} defect code{codes === 1 ? '' : 's'}</span></dd>
        <dt>Dies</dt>
        <dd>
          <strong>{fmt(s.dies)}</strong>
          <span className="cell-muted"> {s.farm_dies ? `incl. ${fmt(s.farm_dies)} farm (${fmt(s.farm_good)} good)` : `${data.level}-level export`}</span>
        </dd>
        <dt>Inspected</dt><dd>{data.file.timestamp}</dd>
      </dl>
    </section>
  )
}

function WaferSourceCard({ data }: Props) {
  return (
    <section className="card">
      <div className="micro-label">Source</div>
      <dl className="facts">
        <dt>File</dt><dd className="break" data-testid="source-file">{data.file.filename}</dd>
        <dt>Folder</dt><dd>{data.file.folder}</dd>
        <dt>Search</dt>
        <dd>
          newest first; found after {fmt(data.file.folders_scanned)} day folder{data.file.folders_scanned === 1 ? '' : 's'}
          {data.file.candidates_in_folder > 1 ? ` (newest of ${data.file.candidates_in_folder} that day)` : ''}
        </dd>
        {data.transaction_id && (<><dt>Transaction</dt><dd className="break">{data.transaction_id}</dd></>)}
      </dl>
    </section>
  )
}
