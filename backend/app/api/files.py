from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..connectors.files import SUPPORTED_FORMATS, detect_file
from ..core.config import get_settings
from ..core.errors import FriendlyError, friendly_from_exception
from ..core.models import FileAsset
from ..core.security import audit
from ..core.storage import get_storage, new_key
from .common import DB, Editor, User

router = APIRouter(prefix="/api", tags=["files"])
DEMO_DIR = Path(__file__).resolve().parents[1] / "demo" / "data"
DEMO_FILES = [
    ("Customer_Data.xlsx", "Customer master data with 4 sheets — duplicates, invalid emails, mixed phone & date formats."),
    ("Orders.csv", "Sales orders — inconsistent statuses, currencies, prices and date formats."),
    ("Vehicles.json", "Nested vehicle registry (owner, specs, features)."),
    ("Service_History.xml", "Dealer service records in XML with nested parts and schema drift."),
    ("Dealer_Export_Bundle.zip", "A ZIP export containing CSV, JSON and XML files."),
]
MAX_API_UPLOAD = 2 * 1024 * 1024 * 1024


def _asset_out(a: FileAsset) -> dict:
    return {"id": a.id, "filename": a.filename, "size_bytes": a.size_bytes, "detection": a.detection}


def _register(db, user, filename: str, key: str, size: int) -> FileAsset:
    storage = get_storage()
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext not in SUPPORTED_FORMATS:
        storage.delete(key)
        raise FriendlyError("Unsupported file type", f"'.{ext}' files aren't supported yet. Supported: Excel, CSV, JSON, XML, Parquet, Avro, TXT and ZIP.")
    try:
        detection = detect_file(storage.path(key), filename)
    except Exception as e:  # noqa: BLE001
        storage.delete(key)
        raise friendly_from_exception(e, context=f"We couldn't read {filename}") from e
    s = get_settings()
    detection["profiling_strategy"] = "databricks" if size > s.local_profile_max_bytes else "local"
    asset = FileAsset(tenant_id=user.tenant_id, filename=filename, storage_key=key, size_bytes=size, detection=detection)
    db.add(asset)
    audit(db, user, "file.upload", asset.id, filename=filename, size=size)
    db.commit()
    return asset


@router.post("/files")
async def upload(db: DB, user: Editor, file: UploadFile = File(...)):
    key = new_key(f"uploads/{user.tenant_id}", file.filename or "upload")
    size = get_storage().put(key, file.file)
    if size > MAX_API_UPLOAD:
        get_storage().delete(key)
        raise FriendlyError("File too large for direct upload", "Use the large-file upload, which sends data straight to cloud storage.")
    return _asset_out(_register(db, user, file.filename or "upload", key, size))


class PresignRequest(BaseModel):
    filename: str
    size_bytes: int


@router.post("/files/presign")
def presign(body: PresignRequest, user: Editor):
    """Large files go Browser → Object Storage directly (pre-signed URL); the API never proxies the bytes in cloud mode."""
    key = new_key(f"uploads/{user.tenant_id}", body.filename)
    return get_storage().presign_upload(key) | {"filename": body.filename}


@router.put("/files/direct-upload/{key:path}")
async def direct_upload(key: str, request: Request, user: Editor):
    if not key.startswith(f"uploads/{user.tenant_id}/"):
        raise FriendlyError("Not allowed", "Invalid upload location.", status_code=403)
    path = get_storage().path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        async for chunk in request.stream():
            fh.write(chunk)
    return {"key": key, "size_bytes": path.stat().st_size}


class CompleteUpload(BaseModel):
    key: str
    filename: str


@router.post("/files/complete")
def complete(body: CompleteUpload, db: DB, user: Editor):
    if not body.key.startswith(f"uploads/{user.tenant_id}/") or not get_storage().exists(body.key):
        raise FriendlyError("Upload not found", "The upload didn't finish. Please try again.", status_code=404)
    return _asset_out(_register(db, user, body.filename, body.key, get_storage().path(body.key).stat().st_size))


@router.get("/files/{file_id}")
def get_file(file_id: str, db: DB, user: User):
    a = db.get(FileAsset, file_id)
    if not a or a.tenant_id != user.tenant_id:
        raise FriendlyError("File not found", "This file doesn't exist.", status_code=404)
    return _asset_out(a)


@router.get("/demo-files")
def demo_files(user: User):
    return [{"name": n, "description": d, "size_bytes": (DEMO_DIR / n).stat().st_size} for n, d in DEMO_FILES if (DEMO_DIR / n).exists()]


@router.post("/demo-files/{name}/import")
def import_demo(name: str, db: DB, user: Editor):
    if name not in dict(DEMO_FILES):
        raise FriendlyError("Unknown demo file", "Pick one of the sample files.", status_code=404)
    key = new_key(f"uploads/{user.tenant_id}", name)
    with (DEMO_DIR / name).open("rb") as fh:
        size = get_storage().put(key, fh)
    return _asset_out(_register(db, user, name, key, size))


@router.get("/demo-files/{name}/download")
def download_demo(name: str):
    if name not in dict(DEMO_FILES):
        raise FriendlyError("Unknown demo file", "Pick one of the sample files.", status_code=404)
    return FileResponse(DEMO_DIR / name, filename=name)


def copy_demo(dst: Path, name: str) -> None:
    shutil.copy(DEMO_DIR / name, dst)
