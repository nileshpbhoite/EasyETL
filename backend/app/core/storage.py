"""Object storage abstraction. Local filesystem in development; the same interface is
implemented by cloud adapters (S3 / ADLS / GCS) so large files go Browser → Object Storage → Databricks
without passing through the API server."""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import BinaryIO, Protocol

from .config import get_settings


class ObjectStorage(Protocol):
    def put(self, key: str, data: BinaryIO) -> int: ...
    def path(self, key: str) -> Path: ...
    def exists(self, key: str) -> bool: ...
    def presign_upload(self, key: str) -> dict: ...
    def delete(self, key: str) -> None: ...


class LocalObjectStorage:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if not str(p).startswith(str(self.root.resolve())):
            raise ValueError("Invalid storage key")
        return p

    def put(self, key: str, data: BinaryIO) -> int:
        p = self.path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("wb") as fh:
            shutil.copyfileobj(data, fh, length=1024 * 1024)
        return p.stat().st_size

    def exists(self, key: str) -> bool:
        return self.path(key).exists()

    def delete(self, key: str) -> None:
        p = self.path(key)
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.exists():
            p.unlink()

    def presign_upload(self, key: str) -> dict:
        # Local mode uploads through the API's streaming endpoint. Cloud adapters return a
        # pre-signed PUT URL so the browser writes straight to object storage.
        return {"method": "PUT", "url": f"/api/files/direct-upload/{key}", "key": key, "direct_to_cloud": False}


_storage: ObjectStorage | None = None


def get_storage() -> ObjectStorage:
    global _storage
    if _storage is None:
        _storage = LocalObjectStorage(get_settings().storage_root)
    return _storage


def new_key(prefix: str, filename: str) -> str:
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)[-120:]
    return f"{prefix}/{uuid.uuid4().hex[:10]}/{safe}"
