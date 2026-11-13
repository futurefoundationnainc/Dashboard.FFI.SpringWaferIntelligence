"""CloudPCS XML ingestion adapter.

Converts a CloudPCS ``DATACOLLECT`` export (``Document[name=DATA]`` with
``Field[name=ColHeads]`` and ``Field[name=Rows]/Array/Document[name=Rows]``)
into the engine's normalized inspection frame and applies the engine's key
rules (integer keys, no duplicates, every key in the reference, one wafer per
frame), so uniqueness and key validation are identical to CSV uploads.

Status rule (defined by the customer, 2026-10-13):

* ``SPRING_GRADING`` not equal to ``SCRAP`` -> ``Good``.
* ``SPRING_GRADING == SCRAP`` -> defective; the spring's ``Status`` is its
  ``DEFECT_CODE`` (e.g. ``H8``, ``XL``). The export carries no severity, so
  there is no Low/Med/Killer here: the engine's "bad" test is simply
  ``Status != 'Good'`` and works unchanged on code statuses.
* A SCRAP spring with a blank ``DEFECT_CODE`` gets the literal status
  ``UNCODED`` rather than an invented code. CloudPCS writes the placeholders
  ``null`` / ``NONE`` for "no code"; they count as blank.

Two export levels (detected from the columns):

* **spring** (2D ``WaferYield_DefectMonitor``): ``SPRING_NUM`` +
  ``SPRING_GRADING`` (``GOOD`` / ``SCRAP``), one row per spring.
* **die** (3D ``3D_YIELD_MONITOR``): ``DIE_GRADE`` (``A_DIE`` / ``SCRAP``),
  no spring level, one row per die. Same rule: not ``SCRAP`` -> ``Good``,
  ``SCRAP`` -> its ``DEFECT_CODE``. ``Spring_Num`` is 1 (the engine's die
  convention). ``FARM_DIE == F`` marks farm dies, reported separately.

Column mapping::

    PRODUCT        -> Product     (must have a coordinate reference)
    SAMPLEID       -> Wafer_ID
    DIE_NUM        -> Die_Num
    SPRING_NUM     -> Spring_Num
    SPRING_GRADING / DEFECT_CODE -> Status (rule above)
    COMMENTS, SCRAP_STAGE, PROCESS, LOT_REJECT_CODE, EVENT_ID, SPRING_EVENT_TIME
                   -> carried through as metadata (one row per export row)

Parsing is streaming (``iterparse``) so a ~70 MB single-line export does not
need a DOM; only the row tuples are kept.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO

import pandas as pd

from .inspection import OUTPUT_COLUMNS, validate_keys
from .reference import DEFAULT_REF_DIR, KIND_DIE, ReferenceError, layout_kind, list_products, load_reference, valid_spring_keys

SCRAP_GRADING = "SCRAP"
UNCODED_STATUS = "UNCODED"
LEVEL_SPRING = "spring"
LEVEL_DIE = "die"
# CloudPCS placeholders meaning "no defect code".
EMPTY_CODES = {"", "NULL", "NONE", "NAN"}
REQUIRED_XML_COLUMNS = ("PRODUCT", "SAMPLEID", "DIE_NUM", "SPRING_NUM", "SPRING_GRADING", "DEFECT_CODE")
# For die layouts SPRING_NUM may be absent or blank (one row per die).
REQUIRED_XML_COLUMNS_DIE = tuple(c for c in REQUIRED_XML_COLUMNS if c != "SPRING_NUM")
# 3D die-level exports grade the die, not the spring.
REQUIRED_XML_COLUMNS_DIE_GRADE = ("PRODUCT", "SAMPLEID", "DIE_NUM", "DIE_GRADE", "DEFECT_CODE")
METADATA_COLUMNS = ("COMMENTS", "SCRAP_STAGE", "PROCESS", "LOT_REJECT_CODE", "EVENT_ID", "SPRING_EVENT_TIME")
DIE_METADATA_COLUMNS = ("COMMENTS", "DIE_SCRAP_STAGE", "PROCESS", "LOT_REJECT_CODE", "FARM_DIE", "UPLOAD_TIMESTAMP")
FARM_DIE_FLAG = "F"


class CloudPcsAdapterError(ValueError):
    """The export cannot be ingested. ``str(err)`` is specific and actionable."""


def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1]


def parse_cloudpcs_document(source: str | Path | IO[bytes]) -> tuple[dict[str, str], list[str], list[dict[str, str]]]:
    """Stream the export; return ``(header, column_headers, rows)``.

    ``header`` holds the ``Document[name=HEADER]`` fields (``TRANSACTIONID``,
    ``TIMESTAMP`` ...) as strings. Rows are ``{column: string}``. Only those
    elements are kept; every other element is discarded as soon as it closes.
    """
    header: dict[str, str] = {}
    col_heads: list[str] = []
    rows: list[dict[str, str]] = []
    for _event, elem in ET.iterparse(source, events=("end",)):
        tag = _local(elem.tag)
        if tag == "Document" and elem.get("name") == "HEADER" and not header:
            for fld in elem:
                if _local(fld.tag) == "Field":
                    value = next((c.text for c in fld if c.text is not None), None)
                    header[fld.get("name", "")] = (value or "").strip()
            elem.clear()
        elif tag == "Field" and elem.get("name") == "ColHeads" and not col_heads:
            col_heads = [s.text or "" for s in elem.iter() if _local(s.tag) == "String"]
            elem.clear()
        elif tag == "Document" and elem.get("name") == "Rows":
            row: dict[str, str] = {}
            for fld in elem:
                if _local(fld.tag) != "Field":
                    continue
                value = next((c.text for c in fld if c.text is not None), None)
                row[fld.get("name", "")] = "" if value is None else value
            rows.append(row)
            elem.clear()
    if not col_heads and not rows:
        raise CloudPcsAdapterError("Not a CloudPCS DATACOLLECT export: no ColHeads and no Rows documents found.")
    return header, col_heads, rows


def parse_cloudpcs_rows(source: str | Path | IO[bytes]) -> tuple[list[str], list[dict[str, str]]]:
    """Stream the export; return ``(column_headers, rows)`` (see ``parse_cloudpcs_document``)."""
    _header, col_heads, rows = parse_cloudpcs_document(source)
    return col_heads, rows


def grading_to_status(grading: pd.Series, defect_code: pd.Series) -> pd.Series:
    """Apply the customer's rule: not SCRAP -> Good; SCRAP -> its DEFECT_CODE (blank / null / NONE -> UNCODED)."""
    is_scrap = grading.astype(str).str.strip().str.upper().eq(SCRAP_GRADING)
    code = defect_code.astype(str).str.strip()
    code = code.where(~code.str.upper().isin(EMPTY_CODES), UNCODED_STATUS)
    return code.where(is_scrap, "Good")


def _geometry_summary(frame: pd.DataFrame) -> str:
    gangs = frame.Die_Num.nunique()
    per_gang = frame.groupby("Die_Num").Spring_Num.nunique()
    return f"{gangs} gangs x up to {int(per_gang.max())} springs"


@dataclass
class CloudPcsExport:
    """One parsed export, not yet placed on a layout.

    ``frame`` has ``Wafer_ID, Die_Num, Spring_Num, Status`` (integer keys) and ``Stage``
    (scrap stage of a defective unit, banked stage = PROCESS of a Good unit; None if not recorded).
    ``level`` is ``spring`` or ``die``. ``farm_dies`` lists die numbers marked
    ``FARM_DIE = F`` (die exports only). ``header`` is the HEADER document.
    """

    name: str
    product: str
    product_group: str
    level: str
    frame: pd.DataFrame
    metadata: pd.DataFrame
    header: dict[str, str] = field(default_factory=dict)
    farm_dies: list[int] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)

    @property
    def sample_ids(self) -> list[str]:
        return sorted(self.frame.Wafer_ID.unique().tolist())


def _integer_keys(series: pd.Series, name: str) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce")
    if values.isna().any() or not (values % 1 == 0).all():
        raise CloudPcsAdapterError(f"{name}: DIE_NUM / SPRING_NUM must be integers.")
    return values.astype(int)


def parse_cloudpcs_export(source: str | Path | IO[bytes], *, name: str = "cloudpcs.xml") -> CloudPcsExport:
    """Parse and normalize one export without any layout (see the module docstring for the rules).

    Rejections: not a DATACOLLECT export, no rows, missing columns, mixed
    products, non-integer keys, duplicate keys per sample.
    """
    header, col_heads, rows = parse_cloudpcs_document(source)
    if not rows:
        raise CloudPcsAdapterError(f"{name}: the export contains no rows.")
    present = set(col_heads) | set(rows[0].keys())
    level = LEVEL_DIE if ("DIE_GRADE" in present and "SPRING_GRADING" not in present) else LEVEL_SPRING
    required = REQUIRED_XML_COLUMNS_DIE_GRADE if level == LEVEL_DIE else REQUIRED_XML_COLUMNS_DIE
    missing = [c for c in required if c not in present]
    if missing:
        raise CloudPcsAdapterError(f"{name}: export is missing required columns {missing}.")

    raw = pd.DataFrame(rows)
    for col in (*required, "SPRING_NUM", "PRODUCTGROUP", *METADATA_COLUMNS, *DIE_METADATA_COLUMNS):
        if col not in raw.columns:
            raw[col] = ""
        raw[col] = raw[col].fillna("").astype(str).str.strip()

    products = sorted(raw.PRODUCT.unique())
    if len(products) != 1:
        raise CloudPcsAdapterError(f"{name}: export mixes products {products}; one product per export is required.")
    groups = sorted(g for g in raw.PRODUCTGROUP.unique() if g)

    die_num = _integer_keys(raw.DIE_NUM, name)
    if level == LEVEL_DIE:
        spring_num = pd.Series(1, index=raw.index)
        status = grading_to_status(raw.DIE_GRADE, raw.DEFECT_CODE)
        metadata_cols = ["PRODUCT", "PRODUCTGROUP", "SAMPLEID", "DIE_NUM", "DIE_GRADE", "DEFECT_CODE", *DIE_METADATA_COLUMNS]
    else:
        if raw.SPRING_NUM.eq("").all():
            level = LEVEL_DIE  # spring-format export with no spring level: one unit per die
            raw["SPRING_NUM"] = "1"
        spring_num = _integer_keys(raw.SPRING_NUM, name)
        status = grading_to_status(raw.SPRING_GRADING, raw.DEFECT_CODE)
        metadata_cols = ["PRODUCT", "PRODUCTGROUP", "SAMPLEID", "DIE_NUM", "SPRING_NUM", "SPRING_GRADING", "DEFECT_CODE", *METADATA_COLUMNS]

    frame = pd.DataFrame({"Wafer_ID": raw.SAMPLEID, "Die_Num": die_num, "Spring_Num": spring_num, "Status": status})
    # The stage of each unit: for a defective unit its scrap stage (SCRAP_STAGE / DIE_SCRAP_STAGE),
    # for a Good unit its banked stage (PROCESS). CloudPCS "null" placeholders become None.
    # One defect code can come from several scrap stages.
    stage_col = "DIE_SCRAP_STAGE" if level == LEVEL_DIE else "SCRAP_STAGE"
    stage = raw[stage_col].where(status.ne("Good"), raw.PROCESS)
    stage = stage.where(~stage.str.upper().isin(EMPTY_CODES))
    frame["Stage"] = stage.astype(object).where(lambda s: s.notna(), None)
    farm = sorted({int(d) for d in die_num[raw.FARM_DIE.str.upper().eq(FARM_DIE_FLAG)]}) if level == LEVEL_DIE else []
    return CloudPcsExport(
        name=name, product=products[0], product_group=(groups[0] if groups else ""), level=level,
        frame=frame, metadata=raw[metadata_cols].copy(), header=header, farm_dies=farm, columns=list(col_heads),
    )


def place_export(export: CloudPcsExport, ref: pd.DataFrame, layout_label: str) -> list[pd.DataFrame]:
    """Validate an export against a parsed layout; return one engine frame per sample.

    Raises ``CloudPcsAdapterError`` when the export and layout levels differ or
    any export key is missing from the layout (with a geometry summary), and
    applies the standard key rules (duplicates, one wafer per frame).
    """
    name = export.name
    die_layout = layout_kind(ref) == KIND_DIE
    if export.level == LEVEL_DIE and not die_layout:
        raise CloudPcsAdapterError(f"{name}: export has no SPRING_NUM column but layout {layout_label!r} is a spring layout.")
    if export.level == LEVEL_SPRING and die_layout:
        raise CloudPcsAdapterError(f"{name}: export is spring-level but layout {layout_label!r} is a die layout (no spring level).")
    keys = valid_spring_keys(ref)
    frame = export.frame
    unknown = ~pd.MultiIndex.from_frame(frame[["Die_Num", "Spring_Num"]]).isin(keys)
    if unknown.any():
        raise CloudPcsAdapterError(
            f"{name}: {int(unknown.sum())} of {len(frame)} spring keys are not present in the {layout_label} "
            f"reference (export has {_geometry_summary(frame)}; reference has "
            f"{ref.Die_Num.nunique()} gangs x up to {int(ref.groupby('Die_Num').Spring_Num.nunique().max())} springs). "
            "The export geometry does not match the coordinate reference."
        )
    return [
        validate_keys(part.reset_index(drop=True), f"{name}:{wafer_id}", keys)[OUTPUT_COLUMNS]
        for wafer_id, part in frame.groupby("Wafer_ID", sort=True)
    ]


def read_cloudpcs_xml(
    source: str | Path | IO[bytes],
    *,
    name: str = "cloudpcs.xml",
    ref_dir: Path | str = DEFAULT_REF_DIR,
    product: str | None = None,
) -> tuple[str, list[pd.DataFrame], pd.DataFrame]:
    """Ingest one export against the layout of its product. Returns ``(product, frames, metadata)``.

    * ``frames`` - one validated engine frame (``Wafer_ID, Die_Num, Spring_Num,
      Status``) per ``SAMPLEID`` (the engine requires one wafer per frame).
      ``Status`` is ``Good`` or a defect code.
    * ``metadata`` - the carried-through columns, one row per export row.

    Rejections, in order, each with a specific message: structural (no rows /
    missing columns), mixed products, non-integer keys, ``product`` filter
    mismatch, no coordinate reference for the product, spring keys not in the
    reference (with a geometry summary), then the standard key validation.
    """
    export = parse_cloudpcs_export(source, name=name)
    xml_product = export.product
    if product is not None and product != xml_product:
        raise CloudPcsAdapterError(f"{name}: export is for product {xml_product!r}, but {product!r} was selected.")
    available = list_products(ref_dir)
    if xml_product not in available:
        raise CloudPcsAdapterError(
            f"{name}: no coordinate reference for product {xml_product!r} in coordinates/ "
            f"(available: {available or 'none'}). The export cannot be placed on a wafer; "
            "add a PRODUCT.xlsx/.csv coordinate reference for it first."
        )
    try:
        ref, _center = load_reference(xml_product, ref_dir)
    except ReferenceError as exc:
        raise CloudPcsAdapterError(f"{name}: {exc}") from exc
    return xml_product, place_export(export, ref, xml_product), export.metadata
