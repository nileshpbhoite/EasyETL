"""The pipeline metadata document — the single source of truth.

Every UI action produces a change to this document. Nothing downstream (preview, lakehouse design,
deployment) reads UI state; it reads validated metadata. Deployment turns metadata into Databricks
resources; the runtime on Databricks interprets the same metadata.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

STEPS = ["source", "analyze", "transform", "configure", "design", "review", "deploy", "monitor"]


def short_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:8]}"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ------------------------------------------------------------------ source
class DatasetRef(BaseModel):
    id: str = Field(default_factory=lambda: short_id("ds_"))
    name: str
    selected: bool = True
    kind: str = "table"  # file | sheet | table | object | endpoint | zip_member | xml_records
    locator: dict[str, Any] = Field(default_factory=dict)  # connector-specific address (file_id, sheet, member...)
    format: str | None = None
    row_count: int | None = None
    column_count: int | None = None
    size_bytes: int | None = None
    modified_at: str | None = None
    incremental_field: str | None = None
    cdc_capable: bool = False
    columns: list[dict[str, Any]] = Field(default_factory=list)


class SourceConfig(BaseModel):
    category: Literal["file", "application", "database", "cloud_storage", "api", "none"] = "none"
    connector: str | None = None
    name: str | None = None
    connection_id: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)  # non-secret settings only
    datasets: list[DatasetRef] = Field(default_factory=list)
    connection_info: dict[str, Any] = Field(default_factory=dict)


# ------------------------------------------------------------------ AI outputs
class Recommendation(BaseModel):
    id: str = Field(default_factory=lambda: short_id("rec_"))
    area: Literal["transformation", "quality", "governance", "ingestion", "lakehouse", "performance"] = "transformation"
    title: str
    reason: str
    impact: Literal["high", "medium", "low"] = "medium"
    confidence: float = 0.8
    expected_benefit: str = ""
    explanation: str = ""
    dataset_id: str | None = None
    # A structured action — NEVER code. Validated by the policy engine before it can be applied.
    action: dict[str, Any] = Field(default_factory=dict)
    status: Literal["pending", "applied", "ignored"] = "pending"
    preselected: bool = True
    destructive: bool = False
    affected_rows: int | None = None
    affected_columns: list[str] = Field(default_factory=list)
    generated_by: str = "heuristic"


class Insight(BaseModel):
    id: str = Field(default_factory=lambda: short_id("ins_"))
    dataset_id: str | None = None
    severity: Literal["info", "success", "warning", "critical"] = "info"
    title: str
    detail: str = ""
    confidence: float | None = None


class AnalysisResult(BaseModel):
    profiled_at: str | None = None
    strategy: str = "local"
    profiles: dict[str, dict[str, Any]] = Field(default_factory=dict)  # dataset_id -> profile
    insights: list[Insight] = Field(default_factory=list)
    relationships: list[dict[str, Any]] = Field(default_factory=list)
    entities: dict[str, str] = Field(default_factory=dict)  # dataset_id -> business entity
    quality_after: dict[str, dict[str, Any]] = Field(default_factory=dict)  # dataset_id -> metrics after transformations


# ------------------------------------------------------------------ transformations
class TransformStep(BaseModel):
    id: str = Field(default_factory=lambda: short_id("t_"))
    type: str
    dataset_id: str
    params: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True
    label: str | None = None
    origin: Literal["user", "ai", "template"] = "user"
    recommendation_id: str | None = None
    created_at: str = Field(default_factory=now_iso)


# ------------------------------------------------------------------ ingestion
class IngestionConfig(BaseModel):
    engine: Literal["auto_loader", "lakeflow_connect", "batch", "streaming", "jdbc", "rest_api"] = "auto_loader"
    recommended_engine: str | None = None
    rationale: str = ""
    mode: Literal["full", "incremental"] = "incremental"
    incremental_field: str | None = None
    cdc: bool = False
    frequency: Literal["continuous", "every_15_min", "hourly", "daily", "weekly", "manual"] = "daily"
    schedule_time: str = "02:00"
    schema_evolution: Literal["add_new_columns", "rescue", "fail_on_change", "none"] = "add_new_columns"
    file_handling: Literal["process_new_only", "reprocess_all", "archive_after_load"] = "process_new_only"
    partition_by: list[str] = Field(default_factory=list)
    compute: Literal["serverless", "small", "medium", "large"] = "serverless"
    retries: int = 3
    retry_delay_minutes: int = 5
    on_error: Literal["quarantine", "skip", "fail"] = "quarantine"
    checkpointing: bool = True
    notes: list[str] = Field(default_factory=list)


# ------------------------------------------------------------------ lakehouse
class TableDesign(BaseModel):
    id: str = Field(default_factory=lambda: short_id("tbl_"))
    layer: Literal["bronze", "silver", "gold"]
    name: str
    description: str = ""
    source_datasets: list[str] = Field(default_factory=list)
    source_tables: list[str] = Field(default_factory=list)
    primary_key: list[str] = Field(default_factory=list)
    partition_by: list[str] = Field(default_factory=list)
    cluster_by: list[str] = Field(default_factory=list)
    columns: list[dict[str, Any]] = Field(default_factory=list)
    business_entity: str | None = None
    gold_logic: dict[str, Any] = Field(default_factory=dict)  # structured aggregation/join spec for gold models
    retention_days: int | None = None
    enabled: bool = True


class LakehouseDesign(BaseModel):
    mode: Literal["simple", "advanced"] = "simple"
    catalog: str = "easyetl"
    bronze_schema: str = "bronze"
    silver_schema: str = "silver"
    gold_schema: str = "gold"
    storage_location: str | None = None
    tables: list[TableDesign] = Field(default_factory=list)
    relationships: list[dict[str, Any]] = Field(default_factory=list)
    retention_days: int = 365
    rationale: list[str] = Field(default_factory=list)


# ------------------------------------------------------------------ governance / quality
class PiiField(BaseModel):
    dataset_id: str
    column: str
    category: str
    confidence: float = 0.8
    action: Literal["tag", "mask", "hash", "tokenize", "restrict", "encrypt", "none"] = "tag"


class AccessPolicy(BaseModel):
    group: str
    privilege: Literal["ALL_PRIVILEGES", "SELECT", "MODIFY", "USE_SCHEMA"] = "SELECT"
    scope: str = "gold"  # layer or table name
    row_filter: str | None = None


class GovernanceConfig(BaseModel):
    unity_catalog: bool = True
    catalog: str = "easyetl"
    tags: dict[str, str] = Field(default_factory=dict)
    pii: list[PiiField] = Field(default_factory=list)
    access_policies: list[AccessPolicy] = Field(default_factory=list)
    audit: bool = True
    lineage: bool = True
    column_masks: bool = True
    data_owner: str | None = None


class QualityRule(BaseModel):
    id: str = Field(default_factory=lambda: short_id("dq_"))
    dataset_id: str
    column: str | None = None
    dimension: Literal["completeness", "uniqueness", "validity", "accuracy", "consistency", "referential_integrity",
                       "range", "pattern", "custom"] = "validity"
    rule: str  # not_null | unique | email | phone | regex | range | in_set | in_reference | min_length | expression
    params: dict[str, Any] = Field(default_factory=dict)
    description: str = ""
    on_fail: Literal["warn", "drop", "quarantine", "fail"] = "warn"
    enabled: bool = True
    origin: Literal["user", "ai", "template"] = "user"


# ------------------------------------------------------------------ deployment
class DeploymentState(BaseModel):
    status: Literal["not_deployed", "deploying", "deployed", "failed"] = "not_deployed"
    mode: Literal["mock", "databricks"] = "mock"
    target_environment: str = "development"
    workspace_url: str | None = None
    deployed_at: str | None = None
    deployed_version: int | None = None
    resources: list[dict[str, Any]] = Field(default_factory=list)
    log: list[dict[str, Any]] = Field(default_factory=list)
    error: dict[str, Any] | None = None


class HealthCheckResult(BaseModel):
    ran_at: str | None = None
    ready: bool = False
    score: int = 0
    checks: list[dict[str, Any]] = Field(default_factory=list)


# ------------------------------------------------------------------ root document
class PipelineMetadata(BaseModel):
    schema_version: int = 1
    name: str = "Untitled pipeline"
    description: str = ""
    mode: Literal["simple", "advanced"] = "simple"
    current_step: str = "source"
    completed_steps: list[str] = Field(default_factory=list)
    template_id: str | None = None
    source: SourceConfig = Field(default_factory=SourceConfig)
    analysis: AnalysisResult = Field(default_factory=AnalysisResult)
    recommendations: list[Recommendation] = Field(default_factory=list)
    transformations: list[TransformStep] = Field(default_factory=list)
    ingestion: IngestionConfig = Field(default_factory=IngestionConfig)
    lakehouse: LakehouseDesign = Field(default_factory=LakehouseDesign)
    governance: GovernanceConfig = Field(default_factory=GovernanceConfig)
    quality_rules: list[QualityRule] = Field(default_factory=list)
    health_check: HealthCheckResult = Field(default_factory=HealthCheckResult)
    deployment: DeploymentState = Field(default_factory=DeploymentState)
    history: list[dict[str, Any]] = Field(default_factory=list)

    # ---- helpers
    def dataset(self, dataset_id: str) -> DatasetRef | None:
        return next((d for d in self.source.datasets if d.id == dataset_id), None)

    def selected_datasets(self) -> list[DatasetRef]:
        return [d for d in self.source.datasets if d.selected]

    def log(self, event: str, **details: Any) -> None:
        self.history.append({"at": now_iso(), "event": event, **details})
        self.history = self.history[-500:]

    def mark_complete(self, step: str) -> None:
        if step not in self.completed_steps:
            self.completed_steps.append(step)

    def resolve_column(self, dataset_id: str, column: str | None) -> str | None:
        """Follow rename steps so rules written against source names keep working after renaming."""
        if not column:
            return column
        import re

        name = column
        for t in self.transformations:
            if t.dataset_id != dataset_id or not t.enabled:
                continue
            if t.type == "rename_columns":
                name = (t.params.get("mapping") or {}).get(name) or name
            elif t.type == "schema_mapping":
                m = next((m for m in t.params.get("mappings") or [] if m.get("source") == name), None)
                name = (m.get("target") or name) if m else name
            elif t.type == "standardize_column_names":
                snake = re.sub(r"_+", "_", re.sub(r"[^\w]+", "_", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name.strip())).strip("_").lower())
                name = snake if t.params.get("style", "snake") == "snake" else name.lower()
        return name

    def export_spec(self) -> dict[str, Any]:
        """The compact, deployable spec (what the Databricks runtime interprets)."""
        return {
            "name": self.name,
            "source": {
                "category": self.source.category,
                "connector": self.source.connector,
                "config": self.source.config,
                "datasets": [
                    {"id": d.id, "name": d.name, "format": d.format, "locator": d.locator,
                     "incremental_field": d.incremental_field}
                    for d in self.selected_datasets()
                ],
            },
            "analysis": {
                "primary_keys": {k: v.get("primary_key_candidates", [{}])[0].get("column") if v.get("primary_key_candidates") else None
                                 for k, v in self.analysis.profiles.items()},
                "entities": self.analysis.entities,
            },
            "transformations": [t.model_dump(include={"id", "type", "dataset_id", "params"}) for t in self.transformations if t.enabled],
            "ingestion": self.ingestion.model_dump(exclude={"notes", "rationale", "recommended_engine"}),
            "lakehouse": self.lakehouse.model_dump(exclude={"rationale"}),
            "governance": self.governance.model_dump(),
            "quality_rules": [{**r.model_dump(), "column": self.resolve_column(r.dataset_id, r.column)} for r in self.quality_rules if r.enabled],
        }
