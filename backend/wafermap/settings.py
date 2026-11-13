"""Wafer Map settings, read from environment variables (IIS web.config, Docker env, or a shell).

| Variable | Default | Meaning |
|---|---|---|
| ``WAFERMAP_SOURCE`` | ``azure`` when a SAS URL is set, else ``local`` | where iXML files are read from |
| ``WAFERMAP_SAS_URL`` | - | Azure Files service URL with SAS query (read + list is enough). Secret. |
| ``WAFERMAP_SHARE`` | ``api-fileshare`` | file share name |
| ``WAFERMAP_ROOT`` | ``risa`` | folder holding ``{yyyy}/{yyyy_MM_dd}/`` day folders |
| ``WAFERMAP_LOCAL_DIR`` | ``backend/dev-share`` | local stand-in for the share (same folder layout) |
| ``WAFERMAP_LOOKBACK_DAYS`` | ``365`` | how far back the newest-first search walks |
| ``WAFERMAP_CACHE_DIR`` | ``backend/.cache`` | day-folder listings, downloaded XML, parsed exports |
| ``WAFERMAP_LIVE_TTL_SECONDS`` | ``120`` | how long a recent or missing day folder's listing is reused |
| ``WAFERMAP_SETTLED_DAYS`` | ``2`` | day folders older than this many days are treated as final and their listing is cached for good (raise it during a backfill) |
| ``WAFERMAP_PREWARM_DAYS`` | ``0`` | day folders listed in the background at startup |
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    source: str
    sas_url: str
    share: str
    root: str
    local_dir: Path
    lookback_days: int
    cache_dir: Path
    live_ttl_seconds: int
    prewarm_days: int
    settled_days: int = 2

    def describe(self) -> dict:
        """Safe-to-show summary (never the SAS token)."""
        # No server paths and never the SAS token: this goes to the browser.
        where = f"Azure Files share '{self.share}'" if self.source == "azure" else f"local folder '{self.local_dir.name}'"
        return {"source": self.source, "location": f"{where}, /{self.root}/yyyy/yyyy_MM_dd/", "lookback_days": self.lookback_days}


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def load_settings() -> Settings:
    sas_url = os.environ.get("WAFERMAP_SAS_URL", "").strip()
    source = os.environ.get("WAFERMAP_SOURCE", "").strip().lower() or ("azure" if sas_url else "local")
    return Settings(
        source=source,
        sas_url=sas_url,
        share=os.environ.get("WAFERMAP_SHARE", "api-fileshare").strip(),
        root=os.environ.get("WAFERMAP_ROOT", "risa").strip().strip("/"),
        local_dir=Path(os.environ.get("WAFERMAP_LOCAL_DIR", BACKEND / "dev-share")),
        lookback_days=max(1, _int("WAFERMAP_LOOKBACK_DAYS", 365)),
        cache_dir=Path(os.environ.get("WAFERMAP_CACHE_DIR", BACKEND / ".cache")),
        live_ttl_seconds=max(0, _int("WAFERMAP_LIVE_TTL_SECONDS", 120)),
        prewarm_days=max(0, _int("WAFERMAP_PREWARM_DAYS", 0)),
        settled_days=max(1, _int("WAFERMAP_SETTLED_DAYS", 2)),
    )
