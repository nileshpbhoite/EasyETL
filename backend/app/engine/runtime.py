"""Runtime access to a pipeline's data: builds the connector from metadata, loads datasets (with caching),
and applies transformation metadata. Profiling strategy is chosen automatically by size."""
from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from pathlib import Path
from typing import Any

import polars as pl
from sqlalchemy.orm import Session

from ..connectors.base import Connector
from ..connectors.registry import get_connector_class
from ..core.config import get_settings
from ..core.errors import FriendlyError, friendly_from_exception
from ..core.models import Connection, FileAsset
from ..core.security import SecretStore
from ..core.storage import get_storage
from ..profiling.profiler import profile_dataframe
from ..transforms.executor import apply_steps, with_row_id
from ..transforms.library import TransformContext
from .metadata import DatasetRef, PipelineMetadata

_CACHE: "OrderedDict[str, pl.DataFrame]" = OrderedDict()
_CACHE_MAX = 24


def _cache_get(key: str) -> pl.DataFrame | None:
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    return None


def _cache_put(key: str, df: pl.DataFrame) -> None:
    _CACHE[key] = df
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)


def clear_cache() -> None:
    _CACHE.clear()


class PipelineRuntime:
    def __init__(self, db: Session, tenant_id: str, meta: PipelineMetadata, pipeline_id: str | None = None):
        self.db, self.tenant_id, self.meta, self.pipeline_id = db, tenant_id, meta, pipeline_id
        self.settings = get_settings()
        self._transformed: dict[str, pl.DataFrame] = {}

    # ------------------------------------------------------------ connector
    def resolve_file(self, file_id: str) -> tuple[Path, str, dict]:
        asset = self.db.get(FileAsset, file_id)
        if not asset or asset.tenant_id != self.tenant_id:
            raise FriendlyError("File not found", "The uploaded file is no longer available. Please upload it again.", status_code=404)
        return get_storage().path(asset.storage_key), asset.filename, asset.detection or {}

    def secrets(self) -> dict:
        src = self.meta.source
        if not src.connection_id:
            return {}
        conn = self.db.get(Connection, src.connection_id)
        if not conn or conn.tenant_id != self.tenant_id:
            return {}
        return SecretStore(self.db, self.tenant_id).get(conn.secret_ref)

    def connector(self) -> Connector:
        src = self.meta.source
        if not src.connector:
            raise FriendlyError("No source selected", "Choose a data source first.")
        cls = get_connector_class(src.connector)
        return cls(src.config, self.secrets(), context={"resolve_file": self.resolve_file})

    # ------------------------------------------------------------ data
    def _key(self, ds: DatasetRef, limit: int | None) -> str:
        sig = json.dumps({"t": self.tenant_id, "c": self.meta.source.connector, "cfg": self.meta.source.config, "loc": ds.locator, "l": limit}, sort_keys=True, default=str)
        return hashlib.sha1(sig.encode()).hexdigest()

    def raw(self, dataset_id: str, limit: int | None = None) -> pl.DataFrame:
        ds = self.meta.dataset(dataset_id)
        if not ds:
            raise FriendlyError("Dataset not found", "This dataset is no longer part of the pipeline.", status_code=404)
        limit = limit or self.settings.profile_sample_rows
        key = self._key(ds, limit)
        cached = _cache_get(key)
        if cached is not None:
            return cached
        disk = get_storage().path(f"cache/{self.tenant_id}/{key}.parquet")
        if disk.exists():
            df = pl.read_parquet(disk)
        else:
            try:
                df = self.connector().read(ds, limit=limit)
            except FriendlyError:
                raise
            except Exception as e:  # noqa: BLE001
                raise friendly_from_exception(e, context=f"We couldn't read {ds.name}") from e
            disk.parent.mkdir(parents=True, exist_ok=True)
            try:
                df.write_parquet(disk)
            except Exception:  # noqa: BLE001 - cache is best effort
                pass
        df = with_row_id(df)
        _cache_put(key, df)
        return df

    def context(self) -> TransformContext:
        return TransformContext(load_dataset=self.transformed, secret_key=(self.settings.jwt_secret + self.tenant_id).encode())

    def steps_for(self, dataset_id: str):
        return [s for s in self.meta.transformations if s.dataset_id == dataset_id]

    def transformed(self, dataset_id: str) -> pl.DataFrame:
        """A dataset after all of its enabled transformations (used for joins/lookups and outputs)."""
        if dataset_id in self._transformed:
            return self._transformed[dataset_id]
        self._transformed[dataset_id] = pl.DataFrame()  # recursion guard for circular joins
        df, _ = apply_steps(self.raw(dataset_id), self.steps_for(dataset_id), self.context())
        self._transformed[dataset_id] = df
        return df

    def columns_after(self, dataset_id: str) -> list[str]:
        return [c for c in self.transformed(dataset_id).columns if c != "__row_id"]

    # ------------------------------------------------------------ profiling
    def profiling_strategy(self, ds: DatasetRef) -> str:
        size = ds.size_bytes or 0
        if size > self.settings.local_profile_max_bytes or (ds.row_count or 0) > 5_000_000:
            return "databricks"
        return "local"

    def profile(self, dataset_id: str) -> dict[str, Any]:
        ds = self.meta.dataset(dataset_id)
        assert ds is not None
        strategy = self.profiling_strategy(ds)
        # Large sources: profile a representative sample here; the full-volume profile runs as a Databricks job
        # (see deploy/databricks.py: submit_profiling_job) and replaces these statistics when it completes.
        df = self.raw(dataset_id)
        prof = profile_dataframe(df, ds.name, total_rows=ds.row_count if ds.row_count and ds.row_count > df.height else None)
        prof["strategy"] = strategy
        return prof
