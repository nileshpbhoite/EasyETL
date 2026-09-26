from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..ai.assistant import answer as assistant_answer
from ..connectors.registry import get_connector_class
from ..core.errors import FriendlyError
from ..core.models import Connection, Pipeline, PipelineRun, PipelineVersion, Template
from ..core.security import SecretStore, audit
from ..deploy.bundle import build_bundle
from ..deploy.deployer import get_deployer
from ..engine import quality as dq
from ..engine import service
from ..engine.health import estimate_cost
from ..engine.metadata import STEPS, AccessPolicy, DatasetRef, PiiField, QualityRule, TableDesign, TransformStep, now_iso
from ..engine.runtime import PipelineRuntime
from ..monitoring import service as monitoring
from ..transforms.executor import columns_meta, frame_rows, preview_step
from ..transforms.library import describe_step
from .common import DB, Deployer, Editor, User, iso, pipeline_out
from .connectors import split_secrets

router = APIRouter(prefix="/api/pipelines", tags=["pipelines"])


def _ctx(db, user, pipeline_id):
    row, meta = service.load(db, user, pipeline_id)
    return row, meta, PipelineRuntime(db, user.tenant_id, meta, row.id)


def _done(db, user, row, meta, summary: str, **extra) -> dict:
    row = service.save(db, user, row, meta, summary)
    return {**pipeline_out(row, meta), **extra}


# ------------------------------------------------------------------ CRUD
@router.get("")
def list_pipelines(db: DB, user: User):
    rows = db.scalars(select(Pipeline).where(Pipeline.tenant_id == user.tenant_id).order_by(Pipeline.updated_at.desc())).all()
    out = []
    for r in rows:
        p = pipeline_out(r, full=False)
        last = db.scalars(select(PipelineRun).where(PipelineRun.pipeline_id == r.id).order_by(PipelineRun.started_at.desc()).limit(1)).first()
        p["last_run"] = monitoring.run_dict(last) if last else None
        out.append(p)
    return out


class PipelineCreate(BaseModel):
    name: str = "Untitled pipeline"
    mode: str = "simple"
    template_id: str | None = None
    environment: str = "development"


@router.post("")
def create_pipeline(body: PipelineCreate, db: DB, user: Editor):
    template = None
    if body.template_id:
        t = db.get(Template, body.template_id)
        if not t or (t.tenant_id and t.tenant_id != user.tenant_id):
            raise FriendlyError("Template not found", "This template is no longer available.", status_code=404)
        t.uses += 1
        template = {"id": t.id, "name": t.name, "config": t.config}
    row = service.create(db, user, body.name, body.mode, template, body.environment)
    return pipeline_out(row)


@router.get("/{pipeline_id}")
def get_pipeline(pipeline_id: str, db: DB, user: User):
    row, meta = service.load(db, user, pipeline_id)
    return pipeline_out(row, meta)


class PipelinePatch(BaseModel):
    name: str | None = None
    description: str | None = None
    mode: str | None = None
    current_step: str | None = None
    complete_step: str | None = None
    environment: str | None = None


@router.patch("/{pipeline_id}")
def patch_pipeline(pipeline_id: str, body: PipelinePatch, db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    if body.name is not None:
        meta.name = body.name.strip() or meta.name
    if body.description is not None:
        meta.description = body.description
    if body.mode in ("simple", "advanced"):
        meta.mode = body.mode  # type: ignore[assignment]
        meta.lakehouse.mode = body.mode  # type: ignore[assignment]
    if body.current_step in STEPS:
        meta.current_step = body.current_step
    if body.complete_step in STEPS:
        meta.mark_complete(body.complete_step)
    if body.environment:
        row.environment = body.environment
    only_nav = body.name is None and body.description is None and body.mode is None and body.environment is None
    row = service.save(db, user, row, meta, "Navigation" if only_nav else "Pipeline settings updated", snapshot=not only_nav)
    return pipeline_out(row, meta)


@router.delete("/{pipeline_id}")
def delete_pipeline(pipeline_id: str, db: DB, user: Editor):
    row, _ = service.load(db, user, pipeline_id)
    db.query(PipelineRun).filter(PipelineRun.pipeline_id == row.id).delete()
    db.query(PipelineVersion).filter(PipelineVersion.pipeline_id == row.id).delete()
    db.delete(row)
    audit(db, user, "pipeline.delete", pipeline_id)
    db.commit()
    return {"ok": True}


@router.post("/{pipeline_id}/undo")
def undo(pipeline_id: str, db: DB, user: Editor):
    row, _ = service.load(db, user, pipeline_id)
    meta = service.undo(db, user, row)
    return pipeline_out(row, meta)


@router.get("/{pipeline_id}/history")
def history(pipeline_id: str, db: DB, user: User):
    row, meta = service.load(db, user, pipeline_id)
    versions = db.scalars(select(PipelineVersion).where(PipelineVersion.pipeline_id == row.id).order_by(PipelineVersion.version.desc()).limit(100)).all()
    return {"versions": [{"version": v.version, "summary": v.change_summary, "at": iso(v.created_at), "by": v.created_by} for v in versions],
            "events": list(reversed(meta.history[-200:]))}


@router.post("/{pipeline_id}/versions/{version}/restore")
def restore(pipeline_id: str, version: int, db: DB, user: Editor):
    row, _ = service.load(db, user, pipeline_id)
    v = db.scalars(select(PipelineVersion).where(PipelineVersion.pipeline_id == row.id, PipelineVersion.version == version)).first()
    if not v:
        raise FriendlyError("Version not found", "That version no longer exists.", status_code=404)
    from ..engine.metadata import PipelineMetadata

    meta = PipelineMetadata(**v.metadata_doc)
    meta.log("restored", version=version)
    return _done(db, user, row, meta, f"Restored version {version}")


# ------------------------------------------------------------------ source
class SourceIn(BaseModel):
    connector: str
    name: str | None = None
    connection_id: str | None = None
    auth_method: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, Any] = Field(default_factory=dict)
    file_ids: list[str] = Field(default_factory=list)


@router.post("/{pipeline_id}/source")
def set_source(pipeline_id: str, body: SourceIn, db: DB, user: Editor):
    row, meta, _ = _ctx(db, user, pipeline_id)
    cls = get_connector_class(body.connector)
    spec = cls.spec
    prev_selection = {d.name: d.selected for d in meta.source.datasets} if meta.source.connector == body.connector else {}
    if spec.category == "file":
        existing = meta.source.config.get("file_ids", []) if meta.source.connector == "file_upload" else []
        config = {"file_ids": list(dict.fromkeys(existing + body.file_ids))}
        connection_id = None
    elif body.connection_id:
        conn = db.get(Connection, body.connection_id)
        if not conn or conn.tenant_id != user.tenant_id:
            raise FriendlyError("Connection not found", "Choose another saved connection.", status_code=404)
        config, connection_id = dict(conn.config), conn.id
    else:
        config, secrets = split_secrets(body.connector, {**body.config, "auth_method": body.auth_method}, body.secrets)
        ref = SecretStore(db, user.tenant_id).put(secrets)
        conn = Connection(tenant_id=user.tenant_id, name=body.name or f"{spec.name} ({meta.name})", connector=body.connector, config=config, secret_ref=ref)
        db.add(conn)
        db.flush()
        connection_id = conn.id
    meta.source.category = spec.category  # type: ignore[assignment]
    meta.source.connector = body.connector
    meta.source.name = body.name or spec.name
    meta.source.config = {**config, **({"_template_transform_patterns": meta.source.config["_template_transform_patterns"]} if meta.source.config.get("_template_transform_patterns") else {})}
    meta.source.connection_id = connection_id
    rt = PipelineRuntime(db, user.tenant_id, meta, row.id)
    connector = rt.connector()
    test = connector.test_connection()
    meta.source.connection_info = {"ok": test.ok, "title": test.title, "message": test.message, "info": test.info, "technical": test.technical, "tested_at": now_iso()}
    if not test.ok:
        return _done(db, user, row, meta, f"Connection to {spec.name} failed", test=test.model_dump())
    datasets: list[DatasetRef] = connector.discover()
    for d in datasets:
        if d.name in prev_selection:
            d.selected = prev_selection[d.name]
        d.incremental_field = d.incremental_field or connector.detect_incremental(d)
    old_ids = {d.name: d.id for d in meta.source.datasets}
    for d in datasets:  # keep stable ids so transformations stay attached
        if d.name in old_ids:
            d.id = old_ids[d.name]
    meta.source.datasets = datasets
    if spec.category == "file" and meta.name == "Untitled pipeline" and datasets:
        meta.name = f"{datasets[0].name.split(' › ')[0]} modernization"
    meta.mark_complete("source")
    meta.log("source_connected", connector=body.connector, datasets=len(datasets))
    audit(db, user, "pipeline.source", pipeline_id, connector=body.connector)
    return _done(db, user, row, meta, f"Connected {spec.name}", test=test.model_dump())


class SelectionIn(BaseModel):
    selected: dict[str, bool]


@router.patch("/{pipeline_id}/datasets")
def select_datasets(pipeline_id: str, body: SelectionIn, db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    for d in meta.source.datasets:
        if d.id in body.selected:
            d.selected = body.selected[d.id]
    if not meta.selected_datasets():
        raise FriendlyError("Select at least one dataset", "Choose which tables, files or objects to include.")
    return _done(db, user, row, meta, "Dataset selection changed")


@router.get("/{pipeline_id}/datasets/{dataset_id}/preview")
def dataset_preview(pipeline_id: str, dataset_id: str, db: DB, user: User, stage: str = "raw", limit: int = 100):
    _, meta, rt = _ctx(db, user, pipeline_id)
    df = rt.raw(dataset_id) if stage == "raw" else rt.transformed(dataset_id)
    return {"columns": columns_meta(df), "rows": frame_rows(df.drop("__row_id", strict=False), min(limit, 500)), "total_rows": df.height}


@router.get("/{pipeline_id}/datasets/{dataset_id}/columns")
def dataset_columns(pipeline_id: str, dataset_id: str, db: DB, user: User, before_step: str | None = None):
    _, meta, rt = _ctx(db, user, pipeline_id)
    steps = rt.steps_for(dataset_id)
    if before_step:
        idx = next((i for i, s in enumerate(steps) if s.id == before_step), len(steps))
        steps = steps[:idx]
    from ..transforms.executor import apply_steps

    df, _ = apply_steps(rt.raw(dataset_id).head(500), steps, rt.context())
    prof = meta.analysis.profiles.get(dataset_id, {})
    sem = {c["name"]: c["semantic_type"] for c in prof.get("columns", [])}
    return [{"name": c, "type": str(t), "semantic_type": sem.get(c), "kind": _kind(t, sem.get(c))} for c, t in df.schema.items() if c != "__row_id"]


def _kind(t, semantic: str | None) -> str:
    s = str(t)
    if s.startswith(("Struct", "List")):
        return "nested"
    if semantic in ("integer", "decimal", "currency", "percentage") or s.startswith(("Int", "UInt", "Float", "Decimal")):
        return "numeric"
    if semantic in ("date", "date_of_birth", "timestamp") or s.startswith(("Date", "Datetime")):
        return "date"
    return "text"


# ------------------------------------------------------------------ analysis & recommendations
@router.post("/{pipeline_id}/analyze")
def analyze(pipeline_id: str, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    result = service.run_analysis(rt)
    return _done(db, user, row, meta, "AI analysis completed", analysis=result)


class ApplyIn(BaseModel):
    ids: list[str] | None = None


@router.post("/{pipeline_id}/recommendations/apply")
def apply_recs(pipeline_id: str, body: ApplyIn, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    result = service.apply_recommendations(rt, body.ids)
    n = len(result["applied"])
    return _done(db, user, row, meta, f"Applied {n} AI recommendation{'s' if n != 1 else ''}", result=result)


class StatusIn(BaseModel):
    status: str


@router.post("/{pipeline_id}/recommendations/{rec_id}/status")
def rec_status(pipeline_id: str, rec_id: str, body: StatusIn, db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    rec = service.set_recommendation_status(meta, rec_id, body.status)
    return _done(db, user, row, meta, f"Recommendation '{rec.title}' → {body.status}")


@router.post("/{pipeline_id}/recommendations/{rec_id}/preview")
def rec_preview(pipeline_id: str, rec_id: str, db: DB, user: User):
    _, meta, rt = _ctx(db, user, pipeline_id)
    rec = next((r for r in meta.recommendations if r.id == rec_id), None)
    if not rec or rec.action.get("kind") != "add_transform":
        raise FriendlyError("Nothing to preview", "This recommendation doesn't change data.", status_code=404)
    t = rec.action["transform"]
    draft = TransformStep(type=t["type"], dataset_id=rec.dataset_id, params=t.get("params") or {})
    return preview_step(rt.raw(rec.dataset_id), rt.steps_for(rec.dataset_id), None, rt.context(), draft=draft)


# ------------------------------------------------------------------ transformations
class StepIn(BaseModel):
    dataset_id: str
    type: str
    params: dict[str, Any] = Field(default_factory=dict)
    label: str | None = None
    position: int | None = None


@router.post("/{pipeline_id}/transformations")
def add_step(pipeline_id: str, body: StepIn, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    step = service.add_step(rt, body.dataset_id, body.type, body.params, body.label, body.position)
    return _done(db, user, row, meta, f"Added step: {step.label}", step_id=step.id)


class StepPatch(BaseModel):
    params: dict[str, Any] | None = None
    enabled: bool | None = None
    label: str | None = None


@router.patch("/{pipeline_id}/transformations/{step_id}")
def update_step(pipeline_id: str, step_id: str, body: StepPatch, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    step = service.update_step(rt, step_id, body.model_dump(exclude_none=True))
    return _done(db, user, row, meta, f"Updated step: {step.label}")


@router.delete("/{pipeline_id}/transformations/{step_id}")
def delete_step(pipeline_id: str, step_id: str, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    step = next((s for s in meta.transformations if s.id == step_id), None)
    if not step:
        raise FriendlyError("Step not found", "It may already have been removed.", status_code=404)
    meta.transformations.remove(step)
    for r in meta.recommendations:
        if r.id == step.recommendation_id:
            r.status = "pending"
    meta.log("step_deleted", step=step_id, type=step.type)
    service.refresh_quality_after(rt)
    return _done(db, user, row, meta, f"Removed step: {step.label}")


@router.post("/{pipeline_id}/transformations/{step_id}/duplicate")
def duplicate_step(pipeline_id: str, step_id: str, db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    idx = next((i for i, s in enumerate(meta.transformations) if s.id == step_id), None)
    if idx is None:
        raise FriendlyError("Step not found", "It may have been removed.", status_code=404)
    src = meta.transformations[idx]
    copy = TransformStep(type=src.type, dataset_id=src.dataset_id, params=dict(src.params), label=f"{src.label} (copy)", enabled=src.enabled)
    meta.transformations.insert(idx + 1, copy)
    return _done(db, user, row, meta, f"Duplicated step: {src.label}")


class ClearIn(BaseModel):
    dataset_id: str


@router.post("/{pipeline_id}/transformations/clear")
def clear_steps(pipeline_id: str, body: ClearIn, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    removed = [s for s in meta.transformations if s.dataset_id == body.dataset_id]
    meta.transformations = [s for s in meta.transformations if s.dataset_id != body.dataset_id]
    ids = {s.recommendation_id for s in removed}
    for r in meta.recommendations:
        if r.id in ids:
            r.status = "pending"
    meta.log("steps_cleared", dataset=body.dataset_id, count=len(removed))
    service.refresh_quality_after(rt)
    return _done(db, user, row, meta, f"Cleared {len(removed)} transformation steps")


class ReorderIn(BaseModel):
    order: list[str]


@router.post("/{pipeline_id}/transformations/reorder")
def reorder(pipeline_id: str, body: ReorderIn, db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    service.reorder_steps(meta, body.order)
    return _done(db, user, row, meta, "Reordered transformation steps")


class PreviewIn(BaseModel):
    dataset_id: str
    step_id: str | None = None
    draft: dict[str, Any] | None = None
    replace_step_id: str | None = None
    rows: int = 60


@router.post("/{pipeline_id}/preview")
def preview(pipeline_id: str, body: PreviewIn, db: DB, user: User):
    """Before/After preview. Modes: a saved step (step_id), a new draft appended at the end (draft), an edited
    version of an existing step (draft + replace_step_id), or the whole pipeline (neither)."""
    _, meta, rt = _ctx(db, user, pipeline_id)
    draft = TransformStep(type=body.draft["type"], dataset_id=body.dataset_id, params=body.draft.get("params") or {}) if body.draft else None
    steps = rt.steps_for(body.dataset_id)
    if draft and body.replace_step_id:
        idx = next((i for i, s in enumerate(steps) if s.id == body.replace_step_id), len(steps))
        steps = steps[:idx]
    return preview_step(rt.raw(body.dataset_id), steps, None if draft else body.step_id, rt.context(), row_limit=min(body.rows, 200), draft=draft)


# ------------------------------------------------------------------ data quality
@router.get("/{pipeline_id}/quality")
def quality(pipeline_id: str, db: DB, user: User):
    _, meta, rt = _ctx(db, user, pipeline_id)
    out = []
    for d in meta.selected_datasets():
        rules = [r for r in meta.quality_rules if r.dataset_id == d.id]
        raw = rt.raw(d.id)
        after = rt.transformed(d.id)
        before_res = dq.evaluate(raw, rules, rt.transformed)
        after_rules = [r.model_copy(update={"column": meta.resolve_column(d.id, r.column)}) for r in rules]
        after_res = dq.evaluate(after, after_rules, rt.transformed)
        prof = meta.analysis.profiles.get(d.id, {})
        out.append({"dataset_id": d.id, "dataset": d.name, "profile_quality": prof.get("quality"), "before": before_res, "after": after_res,
                    "anomalies": [{"column": c["name"], "outliers": c["outlier_count"], "bounds": c.get("outlier_bounds")}
                                  for c in prof.get("columns", []) if c.get("outlier_count")]})
    return {"datasets": out, "catalog": dq.RULE_CATALOG}


class RuleIn(BaseModel):
    dataset_id: str
    column: str | None = None
    rule: str
    dimension: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)
    description: str | None = None
    on_fail: str = "warn"
    enabled: bool = True


@router.post("/{pipeline_id}/quality-rules")
def add_rule(pipeline_id: str, body: RuleIn, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    from ..ai.policy import validate_quality_rule

    dim = body.dimension or next((c["dimension"] for c in dq.RULE_CATALOG if c["rule"] == body.rule), "custom")
    label = next((c["label"] for c in dq.RULE_CATALOG if c["rule"] == body.rule), body.rule)
    rule = QualityRule(dataset_id=body.dataset_id, column=body.column, rule=body.rule, dimension=dim, params=body.params,  # type: ignore[arg-type]
                       description=body.description or f"{body.column}: {label.lower()}", on_fail=body.on_fail, enabled=body.enabled)  # type: ignore[arg-type]
    problems = validate_quality_rule(rule, meta, rt.columns_after(body.dataset_id))
    if problems:
        raise FriendlyError("Check the rule", " ".join(problems))
    meta.quality_rules.append(rule)
    return _done(db, user, row, meta, f"Added quality rule: {rule.description}")


class RulePatch(BaseModel):
    enabled: bool | None = None
    on_fail: str | None = None
    params: dict[str, Any] | None = None


@router.patch("/{pipeline_id}/quality-rules/{rule_id}")
def patch_rule(pipeline_id: str, rule_id: str, body: RulePatch, db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    rule = next((r for r in meta.quality_rules if r.id == rule_id), None)
    if not rule:
        raise FriendlyError("Rule not found", "It may have been removed.", status_code=404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(rule, k, v)
    return _done(db, user, row, meta, f"Updated quality rule: {rule.description}")


@router.delete("/{pipeline_id}/quality-rules/{rule_id}")
def delete_rule(pipeline_id: str, rule_id: str, db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    meta.quality_rules = [r for r in meta.quality_rules if r.id != rule_id]
    return _done(db, user, row, meta, "Removed a quality rule")


# ------------------------------------------------------------------ configure / design / governance
@router.put("/{pipeline_id}/ingestion")
def put_ingestion(pipeline_id: str, body: dict[str, Any], db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    from ..engine.metadata import IngestionConfig

    merged = {**meta.ingestion.model_dump(), **{k: v for k, v in body.items() if k in IngestionConfig.model_fields}}
    meta.ingestion = IngestionConfig(**merged)
    return _done(db, user, row, meta, "Ingestion settings updated")


@router.put("/{pipeline_id}/lakehouse")
def put_lakehouse(pipeline_id: str, body: dict[str, Any], db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    from ..engine.metadata import LakehouseDesign

    data = {**meta.lakehouse.model_dump(), **{k: v for k, v in body.items() if k in LakehouseDesign.model_fields}}
    if "tables" in body:
        data["tables"] = [TableDesign(**t).model_dump() for t in body["tables"]]
    meta.lakehouse = LakehouseDesign(**data)
    meta.governance.catalog = meta.lakehouse.catalog
    return _done(db, user, row, meta, "Lakehouse design updated")


@router.post("/{pipeline_id}/lakehouse/regenerate")
def regen_lakehouse(pipeline_id: str, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    service.auto_fix(rt, "regenerate_lakehouse")
    return _done(db, user, row, meta, "Lakehouse design regenerated by AI")


@router.put("/{pipeline_id}/governance")
def put_governance(pipeline_id: str, body: dict[str, Any], db: DB, user: Editor):
    row, meta = service.load(db, user, pipeline_id)
    from ..engine.metadata import GovernanceConfig

    data = {**meta.governance.model_dump(), **{k: v for k, v in body.items() if k in GovernanceConfig.model_fields}}
    if "pii" in body:
        data["pii"] = [PiiField(**p).model_dump() for p in body["pii"]]
    if "access_policies" in body:
        data["access_policies"] = [AccessPolicy(**p).model_dump() for p in body["access_policies"]]
    meta.governance = GovernanceConfig(**data)
    return _done(db, user, row, meta, "Governance settings updated")


# ------------------------------------------------------------------ review & deploy
@router.post("/{pipeline_id}/health-check")
def health(pipeline_id: str, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    result = service.health_check(rt)
    if result["ready"]:
        meta.mark_complete("review")
    return _done(db, user, row, meta, f"Readiness check: {result['score']}/100", health=result)


class FixIn(BaseModel):
    fix: str


@router.post("/{pipeline_id}/fix")
def fix(pipeline_id: str, body: FixIn, db: DB, user: Editor):
    row, meta, rt = _ctx(db, user, pipeline_id)
    message = service.auto_fix(rt, body.fix)
    rt._transformed.clear()
    result = service.health_check(rt)
    if result["ready"]:
        meta.mark_complete("review")
    return _done(db, user, row, meta, f"Auto-fix: {message}", message=message, health=result)


@router.get("/{pipeline_id}/cost")
def cost(pipeline_id: str, db: DB, user: User):
    _, meta = service.load(db, user, pipeline_id)
    return estimate_cost(meta)


@router.get("/{pipeline_id}/spec")
def spec(pipeline_id: str, db: DB, user: User):
    _, meta = service.load(db, user, pipeline_id)
    return meta.export_spec()


@router.get("/{pipeline_id}/bundle")
def bundle(pipeline_id: str, db: DB, user: Deployer):
    row, meta = service.load(db, user, pipeline_id)
    return {"files": build_bundle(meta, row.environment)}


class DeployIn(BaseModel):
    environment: str = "development"


@router.post("/{pipeline_id}/deploy")
def deploy(pipeline_id: str, body: DeployIn, db: DB, user: Deployer):
    row, meta, rt = _ctx(db, user, pipeline_id)
    hc = service.health_check(rt)
    if not hc["ready"]:
        meta.health_check = service.run_health_check(rt)
        service.save(db, user, row, meta, "Deployment blocked by readiness check")
        raise FriendlyError("Not ready to deploy", "The readiness check found problems. Fix them on the Review step (many can be fixed automatically).", status_code=409)
    state = get_deployer().deploy(row.id, meta, body.environment)
    state.deployed_version = row.version + 1
    meta.deployment = state
    row.environment = body.environment
    if state.status == "deployed":
        meta.mark_complete("deploy")
        meta.current_step = "monitor"
        row.status = "running"
    meta.log("deployed" if state.status == "deployed" else "deploy_failed", mode=state.mode, environment=body.environment)
    audit(db, user, "pipeline.deploy", pipeline_id, status=state.status, mode=state.mode, environment=body.environment)
    out = _done(db, user, row, meta, f"Deployed to Databricks ({body.environment})" if state.status == "deployed" else "Deployment failed")
    if state.status == "deployed":
        monitoring.ensure_runs(db, row, meta)
    return out


# ------------------------------------------------------------------ monitoring
@router.get("/{pipeline_id}/monitoring")
def monitor(pipeline_id: str, db: DB, user: User):
    row, meta = service.load(db, user, pipeline_id)
    monitoring.ensure_runs(db, row, meta)
    runs = monitoring.runs_for(db, row.id)
    return {"summary": monitoring.summary(meta, row, runs), "runs": [monitoring.run_dict(r) for r in runs[-120:]],
            "alerts": monitoring.detect_anomalies(meta, runs, paused=row.status == "paused"), "deployment": meta.deployment.model_dump(mode="json"),
            "pipeline": pipeline_out(row, meta, full=False)}


@router.post("/{pipeline_id}/pause")
def pause(pipeline_id: str, db: DB, user: Deployer):
    row, meta = service.load(db, user, pipeline_id)
    row.status = "paused"
    audit(db, user, "pipeline.pause", pipeline_id)
    db.commit()
    return pipeline_out(row, meta, full=False)


@router.post("/{pipeline_id}/resume")
def resume(pipeline_id: str, db: DB, user: Deployer):
    row, meta = service.load(db, user, pipeline_id)
    row.status = "running" if meta.deployment.status == "deployed" else "draft"
    audit(db, user, "pipeline.resume", pipeline_id)
    db.commit()
    return pipeline_out(row, meta, full=False)


@router.post("/{pipeline_id}/run-now")
def run_now(pipeline_id: str, db: DB, user: Deployer):
    row, meta = service.load(db, user, pipeline_id)
    if meta.deployment.status != "deployed":
        raise FriendlyError("Not deployed", "Deploy the pipeline before running it.")
    from datetime import datetime, timezone

    base = monitoring._baseline(meta)
    run = monitoring._make_run(row.id, meta, datetime.now(timezone.utc), db.query(PipelineRun).filter(PipelineRun.pipeline_id == row.id).count(), base)
    db.add(run)
    audit(db, user, "pipeline.run", pipeline_id)
    db.commit()
    return monitoring.run_dict(run)


# ------------------------------------------------------------------ lineage
@router.get("/{pipeline_id}/lineage")
def lineage(pipeline_id: str, db: DB, user: User):
    _, meta = service.load(db, user, pipeline_id)
    return build_lineage(meta)


def build_lineage(meta) -> dict:
    nodes, edges = [], []
    lh = meta.lakehouse
    src_id = "source"
    nodes.append({"id": src_id, "type": "source", "label": meta.source.name or "Source", "meta": {"connector": meta.source.connector, "category": meta.source.category,
                                                                                                    "connection": meta.source.connection_info.get("info")}})
    bronze = {ds: t for t in lh.tables if t.layer == "bronze" for ds in t.source_datasets}
    silver = {ds: t for t in lh.tables if t.layer == "silver" for ds in t.source_datasets}
    for ds in meta.selected_datasets():
        raw_id = f"raw:{ds.id}"
        nodes.append({"id": raw_id, "type": "raw", "label": ds.name, "meta": {"rows": ds.row_count, "columns": ds.column_count, "format": ds.format}})
        edges.append({"source": src_id, "target": raw_id})
        prev = raw_id
        if ds.id in bronze:
            b = bronze[ds.id]
            bid = f"table:{b.name}"
            nodes.append({"id": bid, "type": "bronze", "label": b.name, "meta": {"fqn": f"{lh.catalog}.{lh.bronze_schema}.{b.name}", "description": b.description,
                                                                                  "ingestion": meta.ingestion.engine}})
            edges.append({"source": prev, "target": bid})
            prev = bid
        for s in [s for s in meta.transformations if s.dataset_id == ds.id and s.enabled]:
            sid = f"step:{s.id}"
            nodes.append({"id": sid, "type": "transformation", "label": s.label or describe_step(s.type, s.params),
                          "meta": {"type": s.type, "params": s.params, "origin": s.origin, "created_at": s.created_at, "description": describe_step(s.type, s.params)}})
            edges.append({"source": prev, "target": sid})
            prev = sid
        if ds.id in silver:
            sv = silver[ds.id]
            svid = f"table:{sv.name}"
            if not any(n["id"] == svid for n in nodes):
                nodes.append({"id": svid, "type": "silver", "label": sv.name, "meta": {"fqn": f"{lh.catalog}.{lh.silver_schema}.{sv.name}", "description": sv.description,
                                                                                        "primary_key": sv.primary_key, "cluster_by": sv.cluster_by,
                                                                                        "quality_rules": sum(1 for r in meta.quality_rules if r.dataset_id == ds.id and r.enabled)}})
            edges.append({"source": prev, "target": svid})
    for g in [t for t in lh.tables if t.layer == "gold" and t.enabled]:
        gid = f"table:{g.name}"
        nodes.append({"id": gid, "type": "gold", "label": g.name, "meta": {"fqn": f"{lh.catalog}.{lh.gold_schema}.{g.name}", "description": g.description, "logic": g.gold_logic}})
        for st in g.source_tables:
            edges.append({"source": f"table:{st}", "target": gid})
        dash = f"dash:{g.name}"
        nodes.append({"id": dash, "type": "dashboard", "label": f"{g.name.replace('_', ' ').title()} dashboard", "meta": {"tool": "Databricks AI/BI"}})
        edges.append({"source": gid, "target": dash})
    return {"nodes": nodes, "edges": edges}


# ------------------------------------------------------------------ templates & assistant
class SaveTemplateIn(BaseModel):
    name: str
    description: str = ""
    category: str = "Custom"


@router.post("/{pipeline_id}/save-template")
def save_template(pipeline_id: str, body: SaveTemplateIn, db: DB, user: Editor):
    _, meta = service.load(db, user, pipeline_id)
    t = Template(tenant_id=user.tenant_id, name=body.name, description=body.description, category=body.category,
                 source_hint=meta.source.category, config=service.template_from_pipeline(meta), created_by=user.id)
    db.add(t)
    audit(db, user, "template.create", t.name, pipeline=pipeline_id)
    db.commit()
    return {"id": t.id, "name": t.name}


class AskIn(BaseModel):
    question: str
    page: str | None = None
    dataset_id: str | None = None
    recommendation_id: str | None = None


@router.post("/{pipeline_id}/assistant")
def ask(pipeline_id: str, body: AskIn, db: DB, user: User):
    _, meta, rt = _ctx(db, user, pipeline_id)
    return assistant_answer(meta, body.question, page=body.page, dataset_id=body.dataset_id, recommendation_id=body.recommendation_id, runtime=rt)
