import type { WaferMapGangRow, WaferMapGeometry } from '../../api/types'
import { fmt } from '../../format'
import type { FeatureLabel } from '../../terms'
import { DataTable, type Column } from '../DataTable'

function columns(feature: FeatureLabel): Column<WaferMapGangRow>[] {
  return [
    { key: 'die', label: 'Die', numeric: true, render: (r) => r.die },
    { key: 'inspected', label: 'Inspected', numeric: true, render: (r) => fmt(r.inspected) },
    { key: 'bad', label: 'Bad', numeric: true, render: (r) => fmt(r.bad) },
    { key: 'total', label: feature.plural, numeric: true, render: (r) => fmt(r.total_springs) },
    { key: 'pct', label: 'Bad %', numeric: true, render: (r) => `${fmt(r.bad_pct * 100, 1)}%` },
    {
      key: 'disposition', label: 'Disposition', render: (r) => r.disposition,
      className: (r) => (r.disposition === 'SCRAP' ? 'status-alarm' : r.disposition === 'INCOMPLETE' ? 'status-warning' : undefined),
    },
  ]
}

interface Props {
  dieYield: NonNullable<WaferMapGeometry['die_yield']>
  feature: FeatureLabel
}

/* Per-die disposition of a feature-level (2D) wafer, below the map. */
export function DieYieldTable({ dieYield, feature }: Props) {
  return (
    <section className="card" style={{ marginTop: 14 }}>
      <div className="card-header">
        <div>
          <div className="micro-label">Die disposition</div>
          <h2 className="card-title">{fmt(dieYield.scrapped)} of {fmt(dieYield.total)} dies SCRAP</h2>
        </div>
      </div>
      <DataTable columns={columns(feature)} rows={dieYield.rows} rowKey={(r) => String(r.die)} pageSize={200} testId="die-yield" />
      <div className="chart-note">{dieYield.rule}</div>
    </section>
  )
}
