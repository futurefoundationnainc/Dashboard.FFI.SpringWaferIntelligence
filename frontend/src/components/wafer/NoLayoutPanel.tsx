import type { WaferMap } from '../../api/types'

interface Props {
  data: WaferMap
  editorHref: string
}

/* Shown in place of the map when no layout matches the wafer's product / group,
   or when the matched layout does not cover every die / feature in the export. */
export function NoLayoutPanel({ data, editorHref }: Props) {
  const missing = data.status === 'no_layout'
  return (
    <div className="no-layout" data-testid="no-layout">
      <div className="no-layout-title">{missing ? 'NO LAYOUT AVAILABLE' : 'LAYOUT DOES NOT MATCH THIS WAFER'}</div>
      <div className="no-layout-text">{data.message}</div>
      <a className="btn btn-accent" href={editorHref} data-testid="open-editor">Open Layout Editor</a>
      <div className="no-layout-hint">
        {missing
          ? `Add a layout for product ${data.product}${data.product_group ? ` or product group ${data.product_group}` : ''}; this map draws as soon as it is saved.`
          : `Edit layout ${data.layout?.name ?? ''} or save a new revision that matches the export.`}
      </div>
    </div>
  )
}
