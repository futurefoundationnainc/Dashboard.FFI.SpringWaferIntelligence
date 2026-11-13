"""Server settings: ``appsettings.json`` next to the app, overridden by environment variables.

Same convention as the 2D / 3D dashboards' GroupsApi: on IIS the API is pointed at
its data folder with an ``appsettings.json`` in the API folder (or with environment
variables on the app pool, which survive deploying to a new folder). The API reads
the settings ONCE, at startup: restart the app pool after editing them.

``appsettings.json`` (all keys optional)::

    {
      "DataDir": "C:\\\\inetpub\\\\dashboard-data\\\\wafermap",   layouts + revisions + map filters in DataDir\\layouts,
                                                            share listings / parsed exports in DataDir\\cache
      "FileShare": {
        "SasUrl": "https://<account>.file.core.windows.net/?sv=...",  SECRET, read + list is enough
        "ShareName": "api-fileshare",
        "Root": "risa",
        "LookbackDays": 365,
        "SettledDays": 2,
        "PrewarmDays": 14
      }
    }

| Environment variable | appsettings.json | Default |
|---|---|---|
| ``REF_DIR`` | ``DataDir`` + ``\\layouts`` | ``backend/coordinates`` (development) |
| ``WAFERMAP_CACHE_DIR`` | ``DataDir`` + ``\\cache`` | ``backend/.cache`` |
| ``WAFERMAP_SAS_URL`` | ``FileShare.SasUrl`` | - (then the local stand-in folder is used) |
| ``WAFERMAP_SOURCE`` | - | ``azure`` when a SAS URL is set, else ``local`` |
| ``WAFERMAP_SHARE`` | ``FileShare.ShareName`` | ``api-fileshare`` |
| ``WAFERMAP_ROOT`` | ``FileShare.Root`` | ``risa`` |
| ``WAFERMAP_LOCAL_DIR`` | - | ``backend/dev-share`` |
| ``WAFERMAP_LOOKBACK_DAYS`` | ``FileShare.LookbackDays`` | ``365`` |
| ``WAFERMAP_SETTLED_DAYS`` | ``FileShare.SettledDays`` | ``2`` (raise during a backfill) |
| ``WAFERMAP_LIVE_TTL_SECONDS`` | - | ``120`` |
| ``WAFERMAP_PREWARM_DAYS`` | ``FileShare.PrewarmDays`` | ``0`` |
| ``WAFERMAP_APPSETTINGS`` | - | ``<backend>/appsettings.json`` (where to read the file) |
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parents[1]


def appsettings_path() -> Path:
    return Path(os.environ.get("WAFERMAP_APPSETTINGS", BACKEND / "appsettings.json"))


def read_appsettings() -> dict[str, Any]:
    """The parsed appsettings.json, or {} when absent or unreadable (health reports which)."""
    path = appsettings_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _file_share(cfg: dict[str, Any]) -> dict[str, Any]:
    share = cfg.get("FileShare")
    return share if isinstance(share, dict) else {}


def _pick(env: str, file_value: Any, default: Any) -> Any:
    raw = os.environ.get(env)
    if raw is not None and raw.strip() != "":
        return raw.strip()
    if file_value not in (None, ""):
        return file_value
    return default


def _int(env: str, file_value: Any, default: int) -> int:
    try:
        return int(_pick(env, file_value, default))
    except (TypeError, ValueError):
        return default


def data_dir() -> Path | None:
    """``DataDir`` from appsettings.json (None when not configured)."""
    value = read_appsettings().get("DataDir")
    return Path(value) if isinstance(value, str) and value.strip() else None


def layouts_dir() -> Path:
    """Where layouts, their revisions and the map filters live (REF_DIR > DataDir\\layouts > backend/coordinates)."""
    base = data_dir()
    return Path(_pick("REF_DIR", str(base / "layouts") if base else None, str(BACKEND / "coordinates")))


def data_dir_configured() -> bool:
    """True when the layouts folder was set explicitly (env or appsettings), not the development default."""
    return bool(os.environ.get("REF_DIR", "").strip()) or data_dir() is not None


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


def load_settings() -> Settings:
    cfg = read_appsettings()
    share = _file_share(cfg)
    base = data_dir()
    sas_url = str(_pick("WAFERMAP_SAS_URL", share.get("SasUrl"), "")).strip()
    source = os.environ.get("WAFERMAP_SOURCE", "").strip().lower() or ("azure" if sas_url else "local")
    return Settings(
        source=source,
        sas_url=sas_url,
        share=str(_pick("WAFERMAP_SHARE", share.get("ShareName"), "api-fileshare")).strip(),
        root=str(_pick("WAFERMAP_ROOT", share.get("Root"), "risa")).strip().strip("/"),
        local_dir=Path(os.environ.get("WAFERMAP_LOCAL_DIR", BACKEND / "dev-share")),
        lookback_days=max(1, _int("WAFERMAP_LOOKBACK_DAYS", share.get("LookbackDays"), 365)),
        cache_dir=Path(_pick("WAFERMAP_CACHE_DIR", str(base / "cache") if base else None, str(BACKEND / ".cache"))),
        live_ttl_seconds=max(0, _int("WAFERMAP_LIVE_TTL_SECONDS", None, 120)),
        prewarm_days=max(0, _int("WAFERMAP_PREWARM_DAYS", share.get("PrewarmDays"), 0)),
        settled_days=max(1, _int("WAFERMAP_SETTLED_DAYS", share.get("SettledDays"), 2)),
    )
