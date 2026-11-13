"""Saved map filters: a shared library with revisions, copy and hide.

A *map filter* is a named rule set the Wafer Map page applies to decide which
springs / dies are drawn, e.g. "defects whose scrap stage starts with 7" or
"stage first 4 digits < 4900". The rules are evaluated in the browser (the
page already has every position's status and stage); this module only
validates and stores them.

Storage: one JSON file, ``map_filters.json``, next to the layouts (``REF_DIR``)
so it lives in the same persistent, backed-up folder. Every save is a new
revision (author, note, time); restoring adds a revision copying an old one;
"delete" hides. Filters are shared by everyone for now; an ``owner`` field can
be added when they are tied to user profiles.
"""
from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError, field_validator

FILTERS_FILE = "map_filters.json"
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()<>=#&+-]{0,79}$")
MAX_RULES = 20

Field_ = Literal["stage", "code", "kind"]
TEXT_OPS = ("equals", "not_equals", "starts_with", "not_starts_with", "contains", "in")
NUMBER_OPS = ("num_lt", "num_le", "num_gt", "num_ge")
OPS_BY_FIELD: dict[str, tuple[str, ...]] = {
    "stage": TEXT_OPS + NUMBER_OPS + ("is_empty", "not_empty"),
    "code": ("equals", "not_equals", "starts_with", "in"),
    "kind": ("equals",),
}


class FilterError(ValueError):
    """A filter cannot be saved / found. ``str(err)`` is the user-facing message."""


class FilterRule(BaseModel):
    field: Field_
    op: str
    value: str = ""
    # For the number operators: how many leading characters of the stage form the number (4: 4025S3PLT -> 4025).
    digits: int = Field(default=4, ge=1, le=12)

    @field_validator("value")
    @classmethod
    def _trim(cls, v: str) -> str:
        return v.strip()[:200]

    def check(self) -> None:
        if self.op not in OPS_BY_FIELD[self.field]:
            raise FilterError(f"Operator {self.op!r} cannot be used with {self.field!r}.")
        if self.op in NUMBER_OPS:
            try:
                float(self.value)
            except ValueError as exc:
                raise FilterError(f"{self.field} {self.op}: {self.value!r} is not a number.") from exc
        elif self.op not in ("is_empty", "not_empty") and not self.value:
            raise FilterError(f"{self.field} {self.op} needs a value.")
        if self.field == "kind" and self.value.lower() not in ("good", "defect"):
            raise FilterError("Status kind must be 'good' or 'defect'.")


class FilterDefinition(BaseModel):
    match: Literal["all", "any"] = "all"
    rules: list[FilterRule] = Field(default_factory=list)

    def check(self) -> None:
        if not self.rules:
            raise FilterError("A filter needs at least one rule.")
        if len(self.rules) > MAX_RULES:
            raise FilterError(f"A filter can have at most {MAX_RULES} rules.")
        for rule in self.rules:
            rule.check()


def parse_definition(raw: Any) -> FilterDefinition:
    try:
        definition = FilterDefinition.model_validate(raw)
    except ValidationError as exc:
        raise FilterError(f"Invalid filter: {exc.errors()[0].get('msg', 'bad value')}.") from exc
    definition.check()
    return definition


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _clean(value: str | None, limit: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def _name(value: str) -> str:
    name = _clean(value, 80)
    if not NAME_PATTERN.match(name):
        raise FilterError("Filter name must be 1-80 characters (letters, digits, spaces and . _ ( ) < > = # & + -), starting with a letter or digit.")
    return name


class FilterStore:
    """The shared filter library in ``<folder>/map_filters.json``. One writer at a time."""

    _locks: dict[str, threading.RLock] = {}
    _locks_guard = threading.Lock()

    def __init__(self, folder: Path | str):
        self.path = Path(folder) / FILTERS_FILE
        # One lock per file, shared by every store instance (the API creates one per request).
        with FilterStore._locks_guard:
            self._lock = FilterStore._locks.setdefault(str(self.path.resolve()), threading.RLock())

    # ------------------------------------------------------------------ io
    def _read(self) -> list[dict]:
        if not self.path.is_file():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return [f for f in (data.get("filters") or []) if isinstance(f, dict) and f.get("id") and f.get("revisions")]

    def _write(self, filters: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{FILTERS_FILE}.tmp")
        tmp.write_text(json.dumps({"filters": filters}, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    @staticmethod
    def _summary(f: dict) -> dict:
        current = f["revisions"][-1]
        return {
            "id": f["id"], "name": f["name"], "hidden": bool(f.get("hidden")), "revision": current["rev"],
            "revision_count": len(f["revisions"]), "saved_at": current["saved_at"], "author": current.get("author", ""),
            "note": current.get("note", ""), "definition": current["definition"], "copied_from": f.get("copied_from"),
        }

    def _find(self, filters: list[dict], filter_id: str) -> dict:
        found = next((f for f in filters if f["id"] == filter_id), None)
        if found is None:
            raise FilterError(f"No map filter {filter_id!r}.")
        return found

    @staticmethod
    def _check_name_free(filters: list[dict], name: str, except_id: str | None = None) -> None:
        for f in filters:
            if f["id"] != except_id and not f.get("hidden") and f["name"].lower() == name.lower():
                raise FilterError(f"A filter named {f['name']!r} already exists. Choose another name or save a revision of it.")

    # ------------------------------------------------------------------ api
    def list(self, include_hidden: bool = True) -> list[dict]:
        items = [self._summary(f) for f in self._read() if include_hidden or not f.get("hidden")]
        return sorted(items, key=lambda i: (i["hidden"], i["name"].lower()))

    def get(self, filter_id: str) -> dict:
        f = self._find(self._read(), filter_id)
        return {**self._summary(f), "revisions": list(reversed(f["revisions"]))}

    def create(self, *, name: str, definition: Any, author: str = "", note: str = "", copied_from: str | None = None) -> dict:
        name = _name(name)
        parsed = parse_definition(definition).model_dump()
        with self._lock:
            filters = self._read()
            self._check_name_free(filters, name)
            entry = {
                "id": uuid.uuid4().hex[:12], "name": name, "hidden": False, "copied_from": copied_from,
                "revisions": [{"rev": 1, "saved_at": _now(), "author": _clean(author, 80), "note": _clean(note, 300),
                               "action": "copy" if copied_from else "create", "name": name, "definition": parsed}],
            }
            filters.append(entry)
            self._write(filters)
        return self._summary(entry)

    def save_revision(self, filter_id: str, *, name: str | None, definition: Any, author: str = "", note: str = "") -> dict:
        parsed = parse_definition(definition).model_dump()
        with self._lock:
            filters = self._read()
            f = self._find(filters, filter_id)
            new_name = _name(name) if name else f["name"]
            self._check_name_free(filters, new_name, except_id=filter_id)
            f["name"] = new_name
            f["revisions"].append({"rev": len(f["revisions"]) + 1, "saved_at": _now(), "author": _clean(author, 80),
                                   "note": _clean(note, 300), "action": "edit", "name": new_name, "definition": parsed})
            self._write(filters)
        return self._summary(f)

    def restore(self, filter_id: str, rev: int, *, author: str = "") -> dict:
        with self._lock:
            filters = self._read()
            f = self._find(filters, filter_id)
            source = next((r for r in f["revisions"] if int(r["rev"]) == int(rev)), None)
            if source is None:
                raise FilterError(f"Filter {f['name']!r} has no revision {rev}.")
            f["revisions"].append({**source, "rev": len(f["revisions"]) + 1, "saved_at": _now(), "author": _clean(author, 80),
                                   "note": f"Restored revision {rev}", "action": "restore", "restored_from": int(rev)})
            self._write(filters)
        return self._summary(f)

    def copy(self, filter_id: str, *, name: str, author: str = "") -> dict:
        source = self._find(self._read(), filter_id)
        return self.create(name=name, definition=source["revisions"][-1]["definition"], author=author,
                           note=f"Copy of {source['name']} rev {source['revisions'][-1]['rev']}", copied_from=filter_id)

    def set_hidden(self, filter_id: str, hidden: bool, *, author: str = "") -> dict:
        with self._lock:
            filters = self._read()
            f = self._find(filters, filter_id)
            if not hidden:
                self._check_name_free(filters, f["name"], except_id=filter_id)
            f["hidden"] = bool(hidden)
            f["hidden_by"] = _clean(author, 80) if hidden else None
            self._write(filters)
        return self._summary(f)
