"""Connector SDK — every source implements the same abstraction:

    authenticate → test_connection → discover → get_schema → read → profile
    → detect_incremental → detect_cdc → read_metadata

Adding a new source means subclassing `Connector`, declaring a `ConnectorSpec` (which drives the no-code
connection wizard in the UI) and registering it.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, ClassVar, Literal

import polars as pl
from pydantic import BaseModel, Field

from ..engine.metadata import DatasetRef


class FieldSpec(BaseModel):
    name: str
    label: str
    type: Literal["text", "password", "number", "select", "boolean", "textarea", "keyvalue", "url"] = "text"
    required: bool = False
    secret: bool = False
    placeholder: str | None = None
    default: Any = None
    options: list[dict[str, str]] = Field(default_factory=list)
    help: str | None = None
    advanced: bool = False
    # Show this field only when other fields have one of the given values, e.g. {"connection_type": ["sql_warehouse"]}
    show_if: dict[str, list[str]] | None = None


class AuthMethod(BaseModel):
    id: str
    label: str
    fields: list[FieldSpec] = Field(default_factory=list)


class ConnectorSpec(BaseModel):
    id: str
    name: str
    category: Literal["file", "application", "database", "warehouse", "cloud_storage", "streaming", "nosql", "api"]
    description: str
    icon: str = "database"
    color: str = "#4f46e5"
    auth_methods: list[AuthMethod] = Field(default_factory=list)
    config_fields: list[FieldSpec] = Field(default_factory=list)
    supports_incremental: bool = True
    supports_cdc: bool = False
    recommended_ingestion: str = "batch"
    availability: Literal["ga", "preview", "sandbox"] = "ga"
    object_label: str = "tables"
    demo_hint: str | None = None
    # What a saved connection can be used for. Targets receive curated Silver/Gold data after a pipeline run.
    roles: list[Literal["source", "target"]] = Field(default_factory=lambda: ["source"])
    target_modes: list[Literal["append", "overwrite", "merge"]] = Field(default_factory=list)
    target_note: str | None = None


class TestResult(BaseModel):
    ok: bool
    title: str
    message: str
    info: dict[str, Any] = Field(default_factory=dict)
    technical: str | None = None


class Connector(ABC):
    spec: ClassVar[ConnectorSpec]

    def __init__(self, config: dict[str, Any], secrets: dict[str, Any] | None = None, *, context: dict[str, Any] | None = None):
        self.config = config or {}
        self.secrets = secrets or {}
        self.context = context or {}

    # -- lifecycle -----------------------------------------------------------
    def authenticate(self) -> None:  # pragma: no cover - default no-op
        """Obtain a session/token. Raise on failure."""

    @abstractmethod
    def test_connection(self) -> TestResult: ...

    @abstractmethod
    def discover(self) -> list[DatasetRef]: ...

    def get_schema(self, dataset: DatasetRef) -> list[dict[str, Any]]:
        df = self.read(dataset, limit=100)
        return [{"name": c, "type": str(t)} for c, t in df.schema.items()]

    @abstractmethod
    def read(self, dataset: DatasetRef, limit: int | None = None) -> pl.DataFrame: ...

    def profile(self, dataset: DatasetRef, sample_rows: int = 200_000) -> dict[str, Any]:
        from ..profiling.profiler import profile_dataframe

        return profile_dataframe(self.read(dataset, limit=sample_rows), dataset_name=dataset.name)

    def detect_incremental(self, dataset: DatasetRef) -> str | None:
        cols = [c["name"] if isinstance(c, dict) else c for c in (dataset.columns or [])]
        for pattern in ("modified_at", "updated_at", "last_modified", "lastmodifieddate", "systemmodstamp", "modified", "updated", "timestamp"):
            for c in cols:
                if c.lower().replace(" ", "_") == pattern or c.lower().endswith(pattern):
                    return c
        return None

    def detect_cdc(self, dataset: DatasetRef) -> bool:
        return bool(self.spec.supports_cdc)

    def read_metadata(self) -> dict[str, Any]:
        return {"connector": self.spec.id, "name": self.spec.name}
