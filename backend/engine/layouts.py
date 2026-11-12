"""Layout management: preview, save (with revisions), list, restore and hide product coordinate references.

A *layout* is a registry entry in ``coordinates/layouts.json`` that names the
layout, lists the design / product names and product groups it serves
(several designs often share one layout; only the probe thickness differs),
and keeps every **revision** it ever had (``rev``, file, author, note, time,
products, groups). The latest revision always draws the map; restoring an
old one adds a new revision that copies it, so history is never rewritten and
no revision file is ever deleted. "Deleting" a layout hides it.

Files that predate the registry keep working: they appear as implicit
layouts named by their file stem (revision 1).

Nothing here changes how a layout is parsed - ``parse_reference`` is the
original code - this module only decides what gets stored where.
"""
from __future__ import annotations

import io
import json
import os
import re
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .reference import (
    DEFAULT_REF_DIR,
    KIND_DIE,
    KIND_SPRING,
    REFERENCE_SUFFIXES,
    REGISTRY_FILE,
    ReferenceError,
    _reference_files,
    entry_groups,
    entry_products,
    gang_bounds,
    implicit_product,
    layout_kind,
    parse_reference,
    read_registry,
    registered_files,
)

WAFER_RADIUS_MM = 100.0
# One writer at a time for the registry (read-modify-write).
_LOCK = threading.RLock()
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$")


class LayoutError(ValueError):
    """A layout cannot be saved / deleted. ``str(err)`` is the user-facing message."""


@dataclass
class LayoutSummary:
    """What the preview and the list show for one layout."""

    springs: int
    gangs: int
    springs_per_gang_min: int
    springs_per_gang_max: int
    center_x: float
    center_y: float
    x_min: float
    x_max: float
    y_min: float
    y_max: float
    max_radius_mm: float
    kind: str = KIND_SPRING
    units: str = "mm"
    pitch_x_mm: float | None = None
    pitch_y_mm: float | None = None
    warnings: list[str] = field(default_factory=list)


def summarize_reference(ref: pd.DataFrame, center: tuple[float, float]) -> LayoutSummary:
    """Descriptive numbers for a parsed layout plus sanity warnings (never errors)."""
    per_gang = ref.groupby("Die_Num").size()
    radius = float(np.hypot(ref.x, ref.y).max())
    kind = layout_kind(ref)
    units = str(ref.attrs.get("units", "mm"))
    pitch = ref.attrs.get("pitch_mm") if kind == KIND_DIE else None
    warnings: list[str] = []
    if units == "um->mm":
        warnings.append("Coordinates were read as micrometres (values beyond 1,000) and converted to millimetres.")
    if radius > WAFER_RADIUS_MM:
        outside = int((np.hypot(ref.x, ref.y) > WAFER_RADIUS_MM).sum())
        warnings.append(f"{outside} features fall outside the 200 mm wafer outline after centering (max radius {radius:.1f} mm). Check units (mm expected) and the coordinate origin.")
    if per_gang.min() != per_gang.max():
        warnings.append(f"Dies do not all have the same feature count ({int(per_gang.min())} to {int(per_gang.max())}). Die yield uses each die's own count.")
    first_spring = ref.groupby("Die_Num").Spring_Num.min()
    if kind == KIND_SPRING and (first_spring != 1).any():
        warnings.append(f"{int((first_spring != 1).sum())} dies do not start at feature (Spring_Num) 1.")
    if ref.Die_Num.min() != 1 or ref.Die_Num.nunique() != ref.Die_Num.max():
        warnings.append(f"Die numbers are not contiguous from 1 ({int(ref.Die_Num.min())} to {int(ref.Die_Num.max())}, {int(ref.Die_Num.nunique())} dies).")
    return LayoutSummary(
        springs=int(len(ref)), gangs=int(ref.Die_Num.nunique()),
        springs_per_gang_min=int(per_gang.min()), springs_per_gang_max=int(per_gang.max()),
        center_x=float(center[0]), center_y=float(center[1]),
        x_min=float(ref.X.min()), x_max=float(ref.X.max()), y_min=float(ref.Y.min()), y_max=float(ref.Y.max()),
        max_radius_mm=radius, kind=kind, units=units,
        pitch_x_mm=(None if not pitch else pitch[0]), pitch_y_mm=(None if not pitch else pitch[1]),
        warnings=warnings,
    )


def _suffix_of(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext not in REFERENCE_SUFFIXES:
        raise LayoutError(f"{filename}: layouts must be .csv or .xlsx files.")
    return ext


def preview_layout(filename: str, payload: bytes) -> tuple[pd.DataFrame, tuple[float, float], LayoutSummary]:
    """Parse an uploaded file without storing anything. Raises ReferenceError / LayoutError."""
    ext = _suffix_of(filename)
    ref, center = parse_reference(io.BytesIO(payload), suffix=ext)
    return ref, center, summarize_reference(ref, center)


def normalize_name(name: str) -> str:
    name = (name or "").strip()
    if not NAME_PATTERN.match(name):
        raise LayoutError("Layout name must be 1-80 characters: letters, digits, spaces, '.', '_' or '-' (and start with a letter or digit).")
    return name


def normalize_products(products: list[str] | None, name: str | None, *, what: str = "Design / product name") -> list[str]:
    """Unique, validated names; an empty product list falls back to ``[name]`` (pass ``name=None`` for no fallback)."""
    seen: list[str] = []
    for raw in products or []:
        p = str(raw).strip()
        if p and p not in seen:
            if not NAME_PATTERN.match(p):
                raise LayoutError(f"{what} {p!r} may only contain letters, digits, spaces, '.', '_' or '-'.")
            seen.append(p)
    if seen or name is None:
        return seen
    return [name]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clean_text(value: str | None, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _revisions(entry: dict) -> list[dict]:
    """An entry's revisions, oldest first. Entries saved before revisions existed get one synthetic revision."""
    revs = [r for r in entry.get("revisions") or [] if isinstance(r, dict) and r.get("file")]
    if revs:
        return revs
    return [{
        "rev": 1, "file": entry["file"], "saved_at": entry.get("saved_at"), "author": entry.get("author") or "",
        "note": entry.get("note") or ("pre-existing file" if entry.get("implicit") else ""),
        "source_filename": entry.get("source_filename"), "products": entry_products(entry),
        "product_groups": entry_groups(entry), "action": "upload",
    }]


def _entries(ref_dir: Path) -> list[dict]:
    """Registry entries (including hidden ones) plus implicit entries for unregistered files."""
    registry = read_registry(ref_dir)
    entries = [dict(e) for e in registry["layouts"] if (ref_dir / e["file"]).is_file()]
    registered = registered_files(ref_dir)
    for p in sorted(_reference_files(ref_dir)):
        if p.name not in registered:
            entries.append({"name": p.stem, "file": p.name, "products": [implicit_product(p)], "implicit": True})
    return entries


def _item(ref_dir: Path, e: dict, *, with_summary: bool) -> dict:
    path = ref_dir / e["file"]
    revs = _revisions(e)
    current = revs[-1]
    item = {
        "name": e["name"], "file": e["file"], "products": entry_products(e), "product_groups": entry_groups(e),
        "implicit": bool(e.get("implicit", False)), "hidden": bool(e.get("hidden", False)),
        "saved_at": e.get("saved_at"), "source_filename": e.get("source_filename"),
        "revision": int(current["rev"]), "revision_count": len(revs),
        "author": current.get("author") or "", "note": current.get("note") or "",
        "size_bytes": path.stat().st_size, "summary": None, "error": None,
    }
    if with_summary:
        try:
            ref, center = parse_reference(path)
            item["summary"] = asdict(summarize_reference(ref, center))
        except (ReferenceError, OSError, ValueError) as exc:
            item["error"] = str(exc)
    return item


def list_layouts(ref_dir: Path | str = DEFAULT_REF_DIR, *, with_summary: bool = True, include_hidden: bool = True) -> list[dict]:
    """Every layout (registered and implicit), newest first, with its summary, file size and current revision."""
    ref_dir = Path(ref_dir)
    if not ref_dir.is_dir():
        return []
    out = [_item(ref_dir, e, with_summary=with_summary) for e in _entries(ref_dir) if include_hidden or not e.get("hidden")]
    out.sort(key=lambda i: (i["saved_at"] or ""), reverse=True)
    return out


def _find(entries: list[dict], name: str) -> dict:
    existing = next((e for e in entries if e["name"].lower() == (name or "").strip().lower()), None)
    if existing is None:
        raise LayoutError(f"No layout named {name!r}.")
    return existing


def get_layout(ref_dir: Path | str, name: str) -> dict:
    """One layout with its full revision history (newest first)."""
    ref_dir = Path(ref_dir)
    entry = _find(_entries(ref_dir) if ref_dir.is_dir() else [], name)
    item = _item(ref_dir, entry, with_summary=True)
    item["revisions"] = [
        {**{k: r.get(k) for k in ("rev", "file", "saved_at", "author", "note", "source_filename", "action", "restored_from")},
         "products": [str(p) for p in r.get("products") or []], "product_groups": [str(g) for g in r.get("product_groups") or []],
         "current": int(r["rev"]) == item["revision"],
         "available": (ref_dir / r["file"]).is_file()}
        for r in reversed(_revisions(entry))
    ]
    return item


def load_revision(ref_dir: Path | str, name: str, rev: int | None = None) -> tuple[pd.DataFrame, tuple[float, float], dict]:
    """Parse one revision (``None`` = current) of a layout. Returns ``(ref, center, revision record)``."""
    ref_dir = Path(ref_dir)
    entry = _find(_entries(ref_dir) if ref_dir.is_dir() else [], name)
    revs = _revisions(entry)
    record = revs[-1] if rev is None else next((r for r in revs if int(r["rev"]) == int(rev)), None)
    if record is None:
        raise LayoutError(f"Layout {entry['name']!r} has no revision {rev}.")
    path = ref_dir / record["file"]
    if not path.is_file():
        raise LayoutError(f"The file of revision {record['rev']} of {entry['name']!r} is missing ({record['file']}).")
    ref, center = parse_reference(path)
    return ref, center, record


def _write_registry(ref_dir: Path, entries: list[dict]) -> None:
    payload = {"layouts": [{k: v for k, v in e.items() if k != "implicit"} for e in entries]}
    tmp = ref_dir / f".{REGISTRY_FILE}.tmp"
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, ref_dir / REGISTRY_FILE)


def _check_names_free(entries: list[dict], owner: dict | None, products: list[str], groups: list[str]) -> None:
    """A product or product group may belong to one visible layout only."""
    for e in entries:
        if (owner is not None and e is owner) or e.get("hidden"):
            continue
        taken = [p for p in products if p in entry_products(e)]
        if taken:
            raise LayoutError(f"Design / product name(s) {taken} already belong to layout {e['name']!r}. Remove them there first or choose other names.")
        taken = [g for g in groups if g in entry_groups(e)]
        if taken:
            raise LayoutError(f"Product group(s) {taken} already belong to layout {e['name']!r}. Remove them there first or choose other names.")


def _apply_revision(entry: dict, record: dict) -> dict:
    """The entry's top-level fields always mirror its latest revision."""
    entry.update({
        "file": record["file"], "products": record["products"], "product_groups": record["product_groups"],
        "source_filename": record.get("source_filename"), "saved_at": record["saved_at"],
        **{k: record[k] for k in ("springs", "gangs", "kind") if k in record},
    })
    entry.pop("implicit", None)
    return entry


def _promote(entry: dict) -> dict:
    """Give an implicit or pre-revision entry an explicit revision list before adding to it."""
    entry = dict(entry)
    entry["revisions"] = _revisions(entry)
    entry.pop("implicit", None)
    return entry


def save_layout(
    ref_dir: Path | str,
    *,
    name: str,
    products: list[str] | None,
    filename: str,
    payload: bytes,
    replace: bool = False,
    product_groups: list[str] | None = None,
    author: str | None = None,
    note: str | None = None,
    action: str = "upload",
) -> dict:
    """Validate a coordinate file and store it as a new layout or a new revision. Returns the list entry.

    * Parsing errors are raised as ``ReferenceError`` before anything is written.
    * An existing layout with the same name gets a **new revision** only when
      ``replace`` is true; earlier revision files are never removed, so any
      revision can be restored. The latest revision is what draws maps.
    * A product or product group already served by *another* visible layout is rejected.
    """
    ref_dir = Path(ref_dir)
    ref_dir.mkdir(parents=True, exist_ok=True)
    name = normalize_name(name)
    products = normalize_products(products, name)
    groups = normalize_products(product_groups, None, what="Product group")
    ext = _suffix_of(filename)
    ref, center = parse_reference(io.BytesIO(payload), suffix=ext)
    summary = summarize_reference(ref, center)

    with _LOCK:
        entries = _entries(ref_dir)
        existing = next((e for e in entries if e["name"].lower() == name.lower()), None)
        if existing is not None and not replace:
            raise LayoutError(f"A layout named {existing['name']!r} already exists ({existing['file']}). Tick 'Replace existing layout' to add a new revision.")
        _check_names_free(entries, existing, products, groups)

        entry = _promote(existing) if existing is not None else {"name": name, "revisions": []}
        rev = len(entry["revisions"]) + 1
        target = ref_dir / (f"{name}{ext}" if rev == 1 and existing is None else f"{entry['name']}.r{rev:03d}{ext}")
        if target.exists():
            target = ref_dir / f"{entry['name']}.r{rev:03d}.{int(datetime.now().timestamp())}{ext}"
        tmp = ref_dir / f".{target.name}.tmp"
        tmp.write_bytes(payload)
        os.replace(tmp, target)
        record = {
            "rev": rev, "file": target.name, "saved_at": _now(), "author": _clean_text(author, 80), "note": _clean_text(note, 300),
            "source_filename": Path(filename).name, "products": products, "product_groups": groups, "action": action,
            "springs": summary.springs, "gangs": summary.gangs, "kind": summary.kind,
        }
        entry["revisions"].append(record)
        entry["hidden"] = False
        _apply_revision(entry, record)
        entries = [e for e in entries if e is not existing] + [entry]
        _write_registry(ref_dir, entries)
    return _item(ref_dir, entry, with_summary=True)


def update_layout_names(
    ref_dir: Path | str, name: str, *, products: list[str] | None, product_groups: list[str] | None,
    author: str | None = None, note: str | None = None,
) -> dict:
    """New revision that keeps the coordinates and changes which products / groups the layout serves."""
    ref_dir = Path(ref_dir)
    with _LOCK:
        entries = _entries(ref_dir) if ref_dir.is_dir() else []
        existing = _find(entries, name)
        products = normalize_products(products, existing["name"])
        groups = normalize_products(product_groups, None, what="Product group")
        _check_names_free(entries, existing, products, groups)
        entry = _promote(existing)
        current = entry["revisions"][-1]
        record = {**current, "rev": len(entry["revisions"]) + 1, "saved_at": _now(), "author": _clean_text(author, 80),
                  "note": _clean_text(note, 300) or "Changed products / groups", "products": products,
                  "product_groups": groups, "action": "names"}
        record.pop("restored_from", None)
        entry["revisions"].append(record)
        _apply_revision(entry, record)
        _write_registry(ref_dir, [e for e in entries if e is not existing] + [entry])
    return _item(ref_dir, entry, with_summary=True)


def restore_revision(ref_dir: Path | str, name: str, rev: int, *, author: str | None = None, note: str | None = None) -> dict:
    """Roll back by adding a new revision that is a copy of revision ``rev`` (history is never rewritten)."""
    ref_dir = Path(ref_dir)
    with _LOCK:
        entries = _entries(ref_dir) if ref_dir.is_dir() else []
        existing = _find(entries, name)
        entry = _promote(existing)
        source = next((r for r in entry["revisions"] if int(r["rev"]) == int(rev)), None)
        if source is None:
            raise LayoutError(f"Layout {entry['name']!r} has no revision {rev}.")
        if not (ref_dir / source["file"]).is_file():
            raise LayoutError(f"The file of revision {rev} is missing ({source['file']}); it cannot be restored.")
        products = [str(p) for p in source.get("products") or entry_products(entry)]
        groups = [str(g) for g in source.get("product_groups") or []]
        _check_names_free(entries, existing, products, groups)
        record = {**source, "rev": len(entry["revisions"]) + 1, "saved_at": _now(), "author": _clean_text(author, 80),
                  "note": _clean_text(note, 300) or f"Restored revision {rev}", "products": products,
                  "product_groups": groups, "action": "restore", "restored_from": int(rev)}
        entry["revisions"].append(record)
        _apply_revision(entry, record)
        _write_registry(ref_dir, [e for e in entries if e is not existing] + [entry])
    return _item(ref_dir, entry, with_summary=True)


def set_layout_hidden(ref_dir: Path | str, name: str, hidden: bool, *, author: str | None = None) -> dict:
    """Hide (soft-delete) or unhide a layout. Files and revisions are always kept."""
    ref_dir = Path(ref_dir)
    with _LOCK:
        entries = _entries(ref_dir) if ref_dir.is_dir() else []
        existing = _find(entries, name)
        entry = _promote(existing)
        if not hidden:
            _check_names_free(entries, existing, entry_products(entry), entry_groups(entry))
        entry["hidden"] = bool(hidden)
        entry["hidden_at"] = _now() if hidden else None
        entry["hidden_by"] = _clean_text(author, 80) if hidden else None
        _apply_revision(entry, entry["revisions"][-1])
        _write_registry(ref_dir, [e for e in entries if e is not existing] + [entry])
    return _item(ref_dir, entry, with_summary=False)


def delete_layout(ref_dir: Path | str, name: str, *, author: str | None = None) -> dict:
    """Hide a layout (no file is deleted, so it can be restored). Kept for API compatibility."""
    ref_dir = Path(ref_dir)
    entries = _entries(ref_dir) if ref_dir.is_dir() else []
    existing = next((e for e in entries if e["name"].lower() == name.strip().lower() and not e.get("hidden")), None)
    if existing is None:
        raise LayoutError(f"No layout named {name!r}.")
    item = set_layout_hidden(ref_dir, existing["name"], True, author=author)
    return {"name": item["name"], "file": item["file"], "products": item["products"]}


def reference_payload(ref: pd.DataFrame) -> dict:
    """Spring coordinates + gang bounds (+ kind / pitch) in the shape the wafer figure builder draws."""
    bounds = gang_bounds(ref)
    pitch = ref.attrs.get("pitch_mm") if layout_kind(ref) == KIND_DIE else None
    return {
        "kind": layout_kind(ref),
        "pitch": ({"x": pitch[0], "y": pitch[1]} if pitch and pitch[0] is not None and pitch[1] is not None else None),
        "die": ref.Die_Num.astype(int).tolist(),
        "spring": ref.Spring_Num.astype(int).tolist(),
        "x": [float(v) for v in ref.x.tolist()],
        "y": [float(v) for v in ref.y.tolist()],
        "gangs": [{"die": int(d), "xmin": float(b.xmin), "xmax": float(b.xmax), "ymin": float(b.ymin), "ymax": float(b.ymax)} for d, b in bounds.iterrows()],
    }
