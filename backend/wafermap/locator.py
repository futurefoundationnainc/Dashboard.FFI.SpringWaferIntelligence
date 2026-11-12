"""Find a sample's newest iXML on the share (LIFO) and load it, with caching.

File names are written by SentientRISAXMLIngest
(``WorkFlows/XMLDataIngestPipelineWorkFlow.cs``)::

    iXML#{counter}_{DataCollectionPlan}_{yyyy_MM_dd_T_HH_mm_ss}{_ms}_MsgId_MET_{SAMPLEID without '.'}_{...}.xml

* ``DataCollectionPlan`` tells 2D (``WaferYield_DefectMonitor``) from 3D
  (``3D_YIELD_MONITOR``). The ingest also writes a copy *without* the plan
  token; that copy never matches here.
* The timestamp is the ingest server's local time. Its trailing ``_ms`` part
  is .NET minute+second with no padding (not milliseconds), so only
  ``yyyy_MM_dd_T_HH_mm_ss`` is used. The MsgId date is year-day-month and is
  never parsed.
* ``SAMPLEID`` appears without its dot (``W305762.1`` -> ``W3057621``); after
  download the ``SAMPLEID`` inside the XML is checked, so two ids that only
  differ by the dot position cannot be confused.

Search rule (LIFO, agreed 2026-11-12): walk day folders from today back;
inside a folder take the newest matching file (timestamp, then counter); the
first file that really contains the sample wins and the search stops.

Caching: past day folders never change, so their listings are kept on disk
forever; today's and yesterday's are re-listed after ``live_ttl_seconds``.
Parsed exports are kept by file name (files never change); the raw download is
deleted once parsed.
"""
from __future__ import annotations

import json
import pickle
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

from engine.xml_adapter import CloudPcsExport, parse_cloudpcs_export

from .settings import Settings
from .source import FileSource

# Plan key -> DataCollectionPlan token in the file name.
PLANS: dict[str, str] = {"2d": "WaferYield_DefectMonitor", "3d": "3D_YIELD_MONITOR"}
PLAN_LABELS = {"2d": "2D (WaferYield_DefectMonitor)", "3d": "3D (3D_YIELD_MONITOR)"}

_NAME_RE = re.compile(
    r"^iXML#(?P<counter>\d+)_(?P<plan>.+?)_(?P<y>\d{4})_(?P<mo>\d{2})_(?P<d>\d{2})_T_(?P<h>\d{2})_(?P<mi>\d{2})_(?P<s>\d{2})"
    r"(?:_\d+)?_MsgId_[A-Za-z]+_(?P<sample>[A-Za-z0-9]+)_.*\.xml$",
    re.IGNORECASE,
)
_TOKEN_TO_PLAN = {token.lower(): key for key, token in PLANS.items()}
LISTING_VERSION = 1
PARSED_VERSION = 3  # 2: frames carry the scrap Stage; 3: Good units carry their banked stage (PROCESS)
MAX_PARSED_IN_MEMORY = 6


class WaferNotFound(LookupError):
    """No iXML for the sample within the look-back window."""


def normalize_sample(sample_id: str) -> str:
    """The file-name form of a sample id: dots removed, upper case."""
    return re.sub(r"[^A-Za-z0-9]", "", sample_id or "").upper()


def matching_sample(requested: str, sample_ids: list[str]) -> str | None:
    """The SAMPLEID in a file that ``requested`` refers to.

    A dotted id (``W305762.1``, what the dashboards send) must match exactly
    (case-insensitive), so ids that differ only by the dot position stay apart.
    An id typed without its dot (``W3057621``, as in file names) matches on the
    dot-less form.
    """
    req = (requested or "").strip().upper()
    if "." in req:
        return next((s for s in sample_ids if s.upper() == req), None)
    return next((s for s in sample_ids if normalize_sample(s) == normalize_sample(req)), None)


@dataclass(frozen=True)
class IxmlName:
    filename: str
    plan: str
    sample: str
    timestamp: datetime
    counter: int

    @property
    def sort_key(self) -> tuple[datetime, int]:
        return (self.timestamp, self.counter)


def parse_ixml_name(filename: str) -> IxmlName | None:
    """Parse an iXML file name; ``None`` for files without a known plan token."""
    m = _NAME_RE.match(filename)
    if not m:
        return None
    plan = _TOKEN_TO_PLAN.get(m["plan"].lower())
    if plan is None:
        return None
    try:
        ts = datetime(int(m["y"]), int(m["mo"]), int(m["d"]), int(m["h"]), int(m["mi"]), int(m["s"]))
    except ValueError:
        return None
    return IxmlName(filename=filename, plan=plan, sample=m["sample"].upper(), timestamp=ts, counter=int(m["counter"]))


@dataclass
class LocatedFile:
    plan: str
    filename: str
    folder: str
    timestamp: datetime
    counter: int
    candidates_in_folder: int
    folders_scanned: int

    @property
    def path(self) -> str:
        return f"{self.folder}/{self.filename}"

    def to_json(self) -> dict:
        return {
            "plan": self.plan, "plan_label": PLAN_LABELS[self.plan], "collection_plan": PLANS[self.plan], "filename": self.filename, "folder": self.folder,
            "timestamp": self.timestamp.isoformat(sep=" "), "candidates_in_folder": self.candidates_in_folder,
            "folders_scanned": self.folders_scanned,
        }


@dataclass
class _DayIndex:
    """One day folder: sample -> plan -> matching files (newest first)."""

    exists: bool
    by_sample: dict[str, dict[str, list[IxmlName]]] = field(default_factory=dict)
    fetched_at: float = 0.0

    @classmethod
    def build(cls, names: list[str] | None) -> "_DayIndex":
        index = cls(exists=names is not None, fetched_at=time.time())
        for name in names or []:
            parsed = parse_ixml_name(name)
            if parsed:
                index.by_sample.setdefault(parsed.sample, {}).setdefault(parsed.plan, []).append(parsed)
        for plans in index.by_sample.values():
            for files in plans.values():
                files.sort(key=lambda f: f.sort_key, reverse=True)
        return index

    def to_json(self) -> dict:
        return {
            "version": LISTING_VERSION, "exists": self.exists,
            "files": [f.filename for plans in self.by_sample.values() for files in plans.values() for f in files],
        }

    @classmethod
    def from_json(cls, data: dict) -> "_DayIndex | None":
        if data.get("version") != LISTING_VERSION:
            return None
        index = cls.build(data.get("files") or [])
        index.exists = bool(data.get("exists"))
        return index


class Locator:
    def __init__(self, settings: Settings, source: FileSource, *, today: callable = date.today):
        self.settings = settings
        self.source = source
        self._today = today
        self._days: dict[str, _DayIndex] = {}
        self._parsed: OrderedDict[str, CloudPcsExport] = OrderedDict()
        self._lock = threading.Lock()
        self._file_locks: dict[str, threading.Lock] = {}
        for sub in ("listings", "xml", "parsed"):
            (settings.cache_dir / sub).mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ day folders
    def folder_for(self, day: date) -> str:
        return f"{self.settings.root}/{day:%Y}/{day:%Y_%m_%d}"

    def _is_settled(self, day: date) -> bool:
        """A day folder older than ``settled_days`` no longer changes, so its listing is kept for good.
        Newer folders (today, tomorrow for a server clock behind the ingest zone, the last few days)
        are re-listed after ``live_ttl_seconds``."""
        return day < self._today() - timedelta(days=self.settings.settled_days)

    def day_index(self, day: date) -> _DayIndex:
        key = f"{day:%Y_%m_%d}"
        settled = self._is_settled(day)
        with self._lock:
            cached = self._days.get(key)
        # A missing folder is never "settled": it may be created later (late ingestion, a backfill),
        # so it is only reused for the live TTL and never written to disk.
        if cached and ((settled and cached.exists) or time.time() - cached.fetched_at < self.settings.live_ttl_seconds):
            return cached
        disk = self.settings.cache_dir / "listings" / f"{key}.json"
        if cached is None and settled and disk.is_file():
            try:
                loaded = _DayIndex.from_json(json.loads(disk.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                loaded = None
            if loaded is not None:
                with self._lock:
                    self._days[key] = loaded
                return loaded
        index = _DayIndex.build(self.source.list_names(self.folder_for(day)))
        with self._lock:
            self._days[key] = index
        if settled and index.exists:
            tmp = disk.with_suffix(".tmp")
            tmp.write_text(json.dumps(index.to_json()), encoding="utf-8")
            tmp.replace(disk)
        return index

    def search_days(self) -> list[date]:
        """Newest first: tomorrow (ingest zone may be ahead of the server), today, then back."""
        start = self._today() + timedelta(days=1)
        return [start - timedelta(days=i) for i in range(self.settings.lookback_days + 1)]

    def prewarm(self, days: int) -> None:
        for day in self.search_days()[: days + 1]:
            try:
                self.day_index(day)
            except Exception:  # noqa: BLE001 - best effort warm-up; a real request reports errors
                return

    # ------------------------------------------------------------------ search + load
    def candidates(self, sample_id: str, plan: str | None):
        """Yield ``LocatedFile`` newest first (LIFO across day folders)."""
        sample = normalize_sample(sample_id)
        plans = [plan] if plan else list(PLANS)
        for scanned, day in enumerate(self.search_days(), start=1):
            index = self.day_index(day)
            files = [f for p in plans for f in index.by_sample.get(sample, {}).get(p, [])]
            files.sort(key=lambda f: f.sort_key, reverse=True)
            for f in files:
                yield LocatedFile(plan=f.plan, filename=f.filename, folder=self.folder_for(day), timestamp=f.timestamp,
                                  counter=f.counter, candidates_in_folder=len(files), folders_scanned=scanned)

    def locate_and_load(self, sample_id: str, plan: str | None = None) -> tuple[LocatedFile, CloudPcsExport]:
        """The newest file that really contains ``sample_id``, parsed. Raises WaferNotFound."""
        for located in self.candidates(sample_id, plan):
            export = self.load(located)
            if matching_sample(sample_id, export.sample_ids) is not None:
                return located, export
        which = PLAN_LABELS[plan] if plan else "2D or 3D"
        raise WaferNotFound(
            f"No {which} iXML file for sample {sample_id} was found in the last {self.settings.lookback_days} days "
            f"of day folders under /{self.settings.root}/."
        )

    def _file_lock(self, filename: str) -> threading.Lock:
        with self._lock:
            return self._file_locks.setdefault(filename, threading.Lock())

    def load(self, located: LocatedFile) -> CloudPcsExport:
        """Download (once) and parse (once) a located file."""
        name = located.filename
        with self._lock:
            hit = self._parsed.get(name)
            if hit is not None:
                self._parsed.move_to_end(name)
                return hit
        with self._file_lock(name):
            parsed_path = self.settings.cache_dir / "parsed" / f"{_safe(name)}.v{PARSED_VERSION}.pkl"
            export = None
            if parsed_path.is_file():
                try:
                    with open(parsed_path, "rb") as fh:
                        export = pickle.load(fh)  # our own cache file, written below
                except Exception:  # noqa: BLE001 - a stale/corrupt cache entry is rebuilt
                    export = None
            if export is None:
                xml_path = self.settings.cache_dir / "xml" / _safe(name)
                if not xml_path.is_file():
                    tmp = xml_path.with_suffix(".part")
                    self.source.download(located.path, tmp)
                    tmp.replace(xml_path)
                try:
                    export = parse_cloudpcs_export(xml_path, name=name)
                finally:
                    # The parsed copy is all we need again; raw exports are up to ~70 MB each.
                    xml_path.unlink(missing_ok=True)
                tmp = parsed_path.with_suffix(".part")
                with open(tmp, "wb") as fh:
                    pickle.dump(export, fh, protocol=pickle.HIGHEST_PROTOCOL)
                tmp.replace(parsed_path)
        with self._lock:
            self._parsed[name] = export
            while len(self._parsed) > MAX_PARSED_IN_MEMORY:
                self._parsed.popitem(last=False)
        return export


def _safe(filename: str) -> str:
    """File names come from the share listing; keep them to one safe path component."""
    return re.sub(r"[^A-Za-z0-9._#-]", "_", Path(filename).name)
