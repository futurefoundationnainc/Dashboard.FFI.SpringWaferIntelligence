"""``GET /api/health``: proves the deployment, layer by layer (same idea as the GroupsApi's).

A folder that looks writable in Explorer and one the app pool identity can really
write are different things, so this round-trips a probe file instead of reading
ACLs. It also lists existing files the app cannot overwrite (read-only attribute,
or created before the grant so they never inherited it), which break saving a
layout revision while creating new layouts still works.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

from .settings import Settings, appsettings_path, data_dir_configured, read_appsettings

DATA_SUFFIXES = (".json", ".csv", ".xlsx")


def _probe(folder: Path) -> tuple[bool, str | None]:
    probe = folder / f".health-probe-{uuid.uuid4().hex[:8]}"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True, None
    except OSError as exc:
        return False, f"{type(exc).__name__}: {exc.strerror or exc}"


def folder_status(folder: Path, *, list_files: bool) -> dict:
    out: dict = {"path": str(folder), "exists": folder.is_dir(), "writable": False}
    if not out["exists"]:
        out["error"] = f"{folder} does not exist. Create it and grant the app pool Modify (icacls ... /grant \"IIS AppPool\\<pool>:(OI)(CI)M\")."
        return out
    out["writable"], err = _probe(folder)
    if err:
        out["error"] = f"The app pool cannot write to {folder} ({err}). Grant it Modify: icacls \"{folder}\" /grant \"IIS AppPool\\<pool>:(OI)(CI)M\" /T"
    if list_files:
        files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in DATA_SUFFIXES and not p.name.startswith((".", "~$"))]
        out["fileCount"] = len(files)
        out["unwritableFiles"] = sorted(p.name for p in files if not os.access(p, os.W_OK))
        if out["unwritableFiles"] and "error" not in out:
            out["error"] = (f"{len(out['unwritableFiles'])} existing file(s) cannot be overwritten: "
                            f"attrib -R \"{folder}\\*\" and icacls \"{folder}\" /grant \"IIS AppPool\\<pool>:(OI)(CI)M\" /T")
    return out


def health(layouts: Path, settings: Settings) -> dict:
    layouts_status = folder_status(layouts, list_files=True)
    cache_status = folder_status(settings.cache_dir, list_files=False)
    appsettings = appsettings_path()
    share = {
        "source": settings.source,
        "configured": settings.source == "local" or bool(settings.sas_url),  # never the token itself
        "shareName": settings.share,
        "root": settings.root,
        "lookbackDays": settings.lookback_days,
        "settledDays": settings.settled_days,
    }
    problems = [s["error"] for s in (layouts_status, cache_status) if s.get("error")]
    if settings.source == "azure" and not settings.sas_url:
        problems.append("FileShare.SasUrl (or WAFERMAP_SAS_URL) is not set: the wafer map cannot read the share.")
    if not data_dir_configured():
        problems.append("DataDir is not configured: layouts are stored inside the deployment folder and the next redeploy destroys them.")
    return {
        "status": "ok" if not problems else "degraded",
        "appsettings": {"path": str(appsettings), "found": appsettings.is_file(), "readable": bool(read_appsettings()) or not appsettings.is_file()},
        "dataDirConfigured": data_dir_configured(),
        "layoutsDir": layouts_status,
        "cacheDir": cache_status,
        "fileShare": share,
        "error": problems[0] if problems else None,
        "problems": problems,
    }
