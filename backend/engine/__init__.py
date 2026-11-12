"""Wafer Defect Map Intelligence analysis engine.

Pure Python / pandas / numpy / scipy. No Streamlit, no Plotly, no FastAPI.
The functions are the ones from the original Streamlit ``app.py`` moved over
essentially verbatim (see ``reference-source/spring_wafer_app/app.py``); the
only additions are the thin helpers the API needs (product listing, gang
bounds, header metrics, gang yield extracted from the Streamlit tab) and the
CloudPCS XML adapter.

Domain rules preserved here and protected by ``tests/``:

* Missing spring observations stay *Uninspected* and are never counted as Good.
* Gang scrap when bad springs / total reference springs in the gang is
  strictly greater than 60 %; incomplete inspections are flagged INCOMPLETE.
* The coordinate center is the bounding-box midpoint of the reference and is
  reported so the UI can show the registration caveat.
"""
from .analysis import (
    STATES,
    header_metrics,
    individual_wafer_status,
    signature_indicators,
    spatial_analysis,
    stacked_summary,
)
from .gang_yield import SCRAP_THRESHOLD, gang_yield
from .inspection import InspectionError, combine_inspections, read_inspection, validate_inspection, validate_keys
from .layouts import (
    LayoutError,
    LayoutSummary,
    delete_layout,
    get_layout,
    list_layouts,
    load_revision,
    preview_layout,
    reference_payload,
    restore_revision,
    save_layout,
    set_layout_hidden,
    summarize_reference,
    update_layout_names,
)
from .reference import ReferenceError, gang_bounds, list_products, load_reference, parse_reference, resolve_layout, resolve_product, valid_spring_keys
from .xml_adapter import CloudPcsAdapterError, CloudPcsExport, grading_to_status, parse_cloudpcs_export, place_export, read_cloudpcs_xml

__all__ = [
    "update_layout_names",
    "set_layout_hidden",
    "restore_revision",
    "resolve_layout",
    "place_export",
    "parse_cloudpcs_export",
    "load_revision",
    "get_layout",
    "CloudPcsExport",
    "STATES",
    "SCRAP_THRESHOLD",
    "CloudPcsAdapterError",
    "InspectionError",
    "LayoutError",
    "LayoutSummary",
    "ReferenceError",
    "combine_inspections",
    "delete_layout",
    "gang_bounds",
    "gang_yield",
    "header_metrics",
    "individual_wafer_status",
    "list_layouts",
    "list_products",
    "grading_to_status",
    "load_reference",
    "parse_reference",
    "preview_layout",
    "reference_payload",
    "resolve_product",
    "save_layout",
    "read_cloudpcs_xml",
    "read_inspection",
    "signature_indicators",
    "spatial_analysis",
    "stacked_summary",
    "summarize_reference",
    "valid_spring_keys",
    "validate_inspection",
    "validate_keys",
]
