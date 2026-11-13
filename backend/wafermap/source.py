"""Where iXML files live: the Azure Files share in production, a local folder with
the same ``{root}/{yyyy}/{yyyy_MM_dd}/`` layout for development and tests."""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Protocol

from .settings import Settings


class SourceError(RuntimeError):
    """The file share could not be read (auth, network, configuration). Message is user-facing."""


class FileSource(Protocol):
    def list_names(self, folder: str) -> list[str] | None:
        """File names directly in ``folder`` (``None`` when the folder does not exist)."""

    def download(self, path: str, target: Path) -> None:
        """Copy the file at ``path`` to the local ``target``."""


class LocalDirSource:
    def __init__(self, root: Path):
        self.root = Path(root)

    def list_names(self, folder: str) -> list[str] | None:
        path = self.root / folder
        if not path.is_dir():
            return None
        return [p.name for p in path.iterdir() if p.is_file()]

    def download(self, path: str, target: Path) -> None:
        src = self.root / path
        if not src.is_file():
            raise SourceError(f"{path} is no longer in the local share folder.")
        shutil.copyfile(src, target)


class AzureFileShareSource:
    """Azure Files via an account (or share) SAS URL. Only list and read are used."""

    def __init__(self, sas_url: str, share: str):
        if not sas_url:
            raise SourceError("WAFERMAP_SAS_URL is not configured on the server.")
        try:
            from azure.storage.fileshare import ShareServiceClient
        except ImportError as exc:  # pragma: no cover - dependency is in requirements.txt
            raise SourceError("The azure-storage-file-share package is not installed on the server.") from exc
        self._share = ShareServiceClient(account_url=sas_url).get_share_client(share)

    def list_names(self, folder: str) -> list[str] | None:
        from azure.core.exceptions import AzureError, ResourceNotFoundError

        try:
            items = self._share.get_directory_client(folder).list_directories_and_files()
            return [item["name"] for item in items if not item.get("is_directory")]
        except ResourceNotFoundError:
            return None
        except AzureError as exc:
            raise SourceError(f"Could not list {folder} on the file share: {type(exc).__name__}.") from exc

    def download(self, path: str, target: Path) -> None:
        from azure.core.exceptions import AzureError

        try:
            with open(target, "wb") as fh:
                self._share.get_file_client(path).download_file().readinto(fh)
        except AzureError as exc:
            raise SourceError(f"Could not download {path} from the file share: {type(exc).__name__}.") from exc


def make_source(settings: Settings) -> FileSource:
    if settings.source == "azure":
        return AzureFileShareSource(settings.sas_url, settings.share)
    if settings.source == "local":
        return LocalDirSource(settings.local_dir)
    raise SourceError(f"Unknown WAFERMAP_SOURCE {settings.source!r} (use 'azure' or 'local').")
