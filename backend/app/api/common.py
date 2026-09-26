from __future__ import annotations

from datetime import timezone
from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from ..core.db import get_db
from ..core.models import Pipeline
from ..core.security import CurrentUser, get_current_user, require
from ..engine.metadata import PipelineMetadata

DB = Annotated[Session, Depends(get_db)]
User = Annotated[CurrentUser, Depends(get_current_user)]
Editor = Annotated[CurrentUser, Depends(require("edit"))]
Deployer = Annotated[CurrentUser, Depends(require("deploy"))]
ConnManager = Annotated[CurrentUser, Depends(require("manage_connections"))]
Admin = Annotated[CurrentUser, Depends(require("admin"))]


def iso(dt) -> str | None:
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()


def pipeline_out(row: Pipeline, meta: PipelineMetadata | None = None, full: bool = True) -> dict:
    meta = meta or PipelineMetadata(**row.metadata_doc)
    src = meta.source
    silver_or_gold = [t for t in meta.lakehouse.tables if t.layer in ("gold",)]
    base = {
        "id": row.id, "name": row.name, "status": row.status, "environment": row.environment, "version": row.version,
        "created_at": iso(row.created_at), "updated_at": iso(row.updated_at),
        "source_label": src.name or (src.connector or "").replace("_", " ").title() or "Not connected",
        "source_connector": src.connector, "source_category": src.category,
        "dataset_count": len(meta.selected_datasets()),
        "target_label": f"{meta.lakehouse.catalog}.{meta.lakehouse.gold_schema}" if silver_or_gold else "Databricks",
        "current_step": meta.current_step, "completed_steps": meta.completed_steps, "mode": meta.mode,
        "deployment_status": meta.deployment.status, "deployment_mode": meta.deployment.mode,
        "quality_score": _quality(meta), "frequency": meta.ingestion.frequency,
    }
    if full:
        base["metadata"] = meta.model_dump(mode="json")
    return base


def _quality(meta: PipelineMetadata) -> float | None:
    after = [meta.analysis.quality_after[d.id]["quality_score"] for d in meta.selected_datasets() if d.id in meta.analysis.quality_after]
    if after:
        return round(sum(after) / len(after), 1)
    profiles = [meta.analysis.profiles[d.id] for d in meta.selected_datasets() if d.id in meta.analysis.profiles]
    if not profiles:
        return None
    return round(sum(p["quality"]["score"] for p in profiles) / len(profiles), 1)
