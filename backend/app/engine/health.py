"""AI Pipeline Readiness Check + cost estimation. Deterministic checks with plain-English explanations and
safe automatic fixes."""
from __future__ import annotations

import re
from typing import Any

from ..core.config import get_settings
from ..transforms.executor import apply_steps
from .metadata import HealthCheckResult, PipelineMetadata, now_iso
from .runtime import PipelineRuntime

IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]{0,254}$")
SECRET_WORDS = ("password", "secret", "token", "api_key", "private_key", "access_key")

# DBU list prices are illustrative defaults; customers override them per contract in Settings.
DBU_RATE = {"serverless": 0.70, "small": 0.40, "medium": 0.40, "large": 0.40}
DBU_PER_HOUR = {"serverless": 4, "small": 2, "medium": 6, "large": 16}
RUNS_PER_MONTH = {"continuous": 720, "every_15_min": 2880, "hourly": 720, "daily": 30, "weekly": 4, "manual": 2}


def estimate_cost(meta: PipelineMetadata) -> dict[str, Any]:
    rows = sum(d.row_count or 0 for d in meta.selected_datasets())
    size_gb = sum((d.size_bytes or (d.row_count or 0) * 200) for d in meta.selected_datasets()) / 1e9
    ing = meta.ingestion
    runs = RUNS_PER_MONTH.get(ing.frequency, 30)
    incremental_factor = 0.15 if ing.mode == "incremental" else 1.0
    minutes_per_run = max(1.5, 1.2 + rows / 2_000_000 * 4 * (incremental_factor if runs > 30 else 1))
    if ing.frequency == "continuous":
        compute_hours = 720.0
    else:
        compute_hours = runs * minutes_per_run / 60
    dbus = compute_hours * DBU_PER_HOUR[ing.compute]
    compute_cost = dbus * DBU_RATE[ing.compute]
    n_tables = sum(1 for t in meta.lakehouse.tables if t.enabled) or 3
    storage_gb = size_gb * 0.35 * n_tables / max(len(meta.selected_datasets()), 1) * 1.2
    storage_cost = storage_gb * 0.023
    return {"monthly_total_usd": round(compute_cost + storage_cost, 2), "compute_usd": round(compute_cost, 2), "storage_usd": round(storage_cost, 2),
            "dbus_per_month": round(dbus, 1), "runs_per_month": runs, "est_minutes_per_run": round(minutes_per_run, 1),
            "storage_gb": round(storage_gb, 3), "assumptions": "Estimated with list DBU prices and compressed Delta storage; actual costs depend on your contract."}


def fq_tables(meta: PipelineMetadata) -> set[str]:
    lh = meta.lakehouse
    schema = {"bronze": lh.bronze_schema, "silver": lh.silver_schema, "gold": lh.gold_schema}
    return {f"{lh.catalog}.{schema[t.layer]}.{t.name}" for t in lh.tables if t.enabled}


def _table_conflicts(rt: PipelineRuntime) -> list[tuple[str, str]]:
    """Two pipelines must never write the same Unity Catalog table."""
    from sqlalchemy import select

    from ..core.models import Pipeline

    mine = fq_tables(rt.meta)
    out = []
    for row in rt.db.scalars(select(Pipeline).where(Pipeline.tenant_id == rt.tenant_id)).all():
        if row.id == rt.pipeline_id:
            continue
        other = PipelineMetadata(**row.metadata_doc)
        for fq in sorted(mine & fq_tables(other)):
            out.append((fq, row.name))
    return out


def _check(id_: str, label: str, status: str, message: str, fix: str | None = None, details: list[str] | None = None) -> dict:
    return {"id": id_, "label": label, "status": status, "message": message, "fix": fix, "details": details or []}


def run_health_check(rt: PipelineRuntime) -> HealthCheckResult:
    meta = rt.meta
    checks = []
    datasets = meta.selected_datasets()

    # 1 Source
    if not meta.source.connector or not datasets:
        checks.append(_check("source", "Source Ready", "fail", "No source or datasets are selected yet."))
    elif meta.source.connection_info.get("ok") is False:
        checks.append(_check("source", "Source Ready", "fail", "The last connection test failed. Re-test the connection."))
    else:
        checks.append(_check("source", "Source Ready", "pass", f"{len(datasets)} dataset(s) from {meta.source.name or meta.source.connector}."))

    # 2 Schema
    missing = [d.name for d in datasets if d.id not in meta.analysis.profiles]
    if missing:
        checks.append(_check("schema", "Schema Ready", "fail", f"{len(missing)} dataset(s) haven't been analyzed yet.", fix="run_analysis", details=missing))
    else:
        checks.append(_check("schema", "Schema Ready", "pass", "All schemas discovered and profiled."))

    # 3 Transformations
    errors = []
    for d in datasets:
        steps = rt.steps_for(d.id)
        if not steps:
            continue
        try:
            sample = rt.raw(d.id).head(2000)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{d.name}: data couldn't be read ({e})")
            continue
        _, res = apply_steps(sample, steps, rt.context())
        for r in res:
            if r.get("status") == "error":
                step = next(s for s in steps if s.id == r["step_id"])
                errors.append(f"{d.name}: '{step.label or step.type}' — {r.get('message')}")
    n_steps = sum(1 for s in meta.transformations if s.enabled)
    checks.append(_check("transformations", "Transformations Valid", "fail" if errors else "pass",
                         f"{len(errors)} transformation(s) can't run." if errors else f"{n_steps} transformation step(s) validated on sample data.",
                         fix="disable_failing_steps" if errors else None, details=errors))

    # 4 Data quality
    covered = {r.dataset_id for r in meta.quality_rules if r.enabled}
    uncovered = [d.name for d in datasets if d.id not in covered]
    if uncovered:
        checks.append(_check("quality", "Data Quality Configured", "warn", f"{len(uncovered)} dataset(s) have no quality rules.", fix="add_quality_rules", details=uncovered))
    else:
        checks.append(_check("quality", "Data Quality Configured", "pass", f"{sum(1 for r in meta.quality_rules if r.enabled)} rules enabled."))

    # 5 Ingestion
    ing = meta.ingestion
    if ing.mode == "incremental" and ing.engine not in ("auto_loader", "lakeflow_connect") and not ing.incremental_field:
        checks.append(_check("ingestion", "Ingestion Configured", "warn", "Incremental mode needs a change-tracking field (e.g. updated_at).", fix="ingestion_full_refresh"))
    else:
        checks.append(_check("ingestion", "Ingestion Configured", "pass", f"{ing.engine.replace('_', ' ').title()} · {ing.mode} · {ing.frequency.replace('_', ' ')}."))

    # 6 Lakehouse
    lh = meta.lakehouse
    silver_ds = {ds for t in lh.tables if t.layer == "silver" and t.enabled for ds in t.source_datasets}
    lh_problems = [f"No Silver table for {d.name}" for d in datasets if d.id not in silver_ds]
    names = [t.name for t in lh.tables if t.enabled]
    lh_problems += [f"'{n}' isn't a valid table name" for n in names if not IDENT_RE.match(n)]
    lh_problems += [f"Duplicate table name '{n}'" for n in {n for n in names if names.count(n) > 1}]
    conflicts = _table_conflicts(rt)
    lh_problems += [f"{fq} is already produced by pipeline “{other}”" for fq, other in conflicts]
    for ident in (lh.catalog, lh.bronze_schema, lh.silver_schema, lh.gold_schema):
        if not IDENT_RE.match(ident or ""):
            lh_problems.append(f"'{ident}' isn't a valid catalog/schema name")
    checks.append(_check("lakehouse", "Lakehouse Ready", "fail" if lh_problems else "pass",
                         "The Lakehouse design needs attention." if lh_problems else f"{len(names)} tables across Bronze, Silver and Gold.",
                         fix=("prefix_table_names" if conflicts else "regenerate_lakehouse") if lh_problems else None, details=lh_problems))

    # 7 Governance
    gov = meta.governance
    unprotected = [f"{p.column} ({p.category.replace('_', ' ')})" for p in gov.pii if p.action in ("none",) and p.category in ("email", "phone", "date_of_birth", "government_id", "financial")]
    if not gov.unity_catalog:
        checks.append(_check("governance", "Governance Configured", "warn", "Unity Catalog governance is turned off.", fix="enable_unity_catalog"))
    elif unprotected:
        checks.append(_check("governance", "Governance Configured", "warn", f"{len(unprotected)} sensitive column(s) have no protection.", fix="protect_pii", details=unprotected))
    else:
        checks.append(_check("governance", "Governance Configured", "pass", f"Unity Catalog on; {len(gov.pii)} PII column(s) classified; {len(gov.access_policies)} access policies."))

    # 8 Security
    plain = [k for k in meta.source.config if any(w in k.lower() for w in SECRET_WORDS) and meta.source.config.get(k)]
    checks.append(_check("security", "Security", "fail" if plain else "pass",
                         "Credentials found in plain configuration." if plain else "Credentials are encrypted in the secret store; access is role-based.",
                         fix="move_secrets" if plain else None, details=plain))

    # 9 Performance
    big = [d.name for d in datasets if (d.row_count or 0) > 10_000_000]
    unclustered = [t.name for t in lh.tables if t.layer == "silver" and t.enabled and not t.cluster_by and any(ds in [d.id for d in datasets if d.name in big] for ds in t.source_datasets)]
    checks.append(_check("performance", "Performance", "warn" if unclustered else "pass",
                         "Large tables without clustering." if unclustered else "Liquid clustering and incremental processing configured.",
                         fix="add_clustering" if unclustered else None, details=unclustered))

    # 10 Cost
    cost = estimate_cost(meta)
    checks.append(_check("cost", "Cost", "warn" if cost["monthly_total_usd"] > 2000 else "pass",
                         f"Estimated ${cost['monthly_total_usd']:,.2f}/month." + (" Consider a less frequent schedule." if cost["monthly_total_usd"] > 2000 else "")))

    # 11 Dependencies
    selected = {d.id for d in datasets}
    deps = []
    for s in meta.transformations:
        if not s.enabled:
            continue
        refs = [s.params.get("right_dataset")] + list(s.params.get("datasets") or [])
        deps += [f"'{s.label or s.type}' uses a dataset that isn't selected" for r in refs if r and r not in selected]
    checks.append(_check("dependencies", "Dependencies", "fail" if deps else "pass",
                         "Some steps depend on unselected datasets." if deps else "All dataset dependencies are satisfied.",
                         fix="select_dependencies" if deps else None, details=deps))

    # 12 Publish targets
    if meta.targets:
        from ..connectors.registry import CONNECTORS
        from ..core.models import Connection

        problems = []
        table_names = {t.name for t in meta.lakehouse.tables if t.enabled}
        for t in meta.targets:
            if not t.enabled:
                continue
            conn = rt.db.get(Connection, t.connection_id)
            label = t.name or t.connector
            if not conn or conn.tenant_id != rt.tenant_id:
                problems.append(f"{label}: the connection was deleted")
                continue
            spec = CONNECTORS[conn.connector].spec
            if (conn.usage or "source") == "source":
                problems.append(f"{label}: the connection is set up as a source only")
            if t.mode not in spec.target_modes:
                problems.append(f"{label}: '{t.mode}' isn't supported (use {', '.join(spec.target_modes)})")
            if t.mode == "merge" and not t.merge_keys:
                problems.append(f"{label}: merge needs key column(s)")
            missing = [n for n in t.tables if n not in table_names]
            if missing:
                problems.append(f"{label}: unknown table(s) {', '.join(missing)}")
        checks.append(_check("targets", "Targets Configured", "fail" if problems else "pass",
                             "Some publish targets need attention." if problems else f"{sum(1 for t in meta.targets if t.enabled)} extra target(s) will receive curated data after each run.",
                             details=problems))

    # 13 Deployment target
    from ..deploy.deployer import deployment_connection

    s = get_settings()
    conn = deployment_connection(rt.db, rt.tenant_id)
    demo = conn is not None and (conn.config.get("host") or "").strip().lower() in ("", "demo", "demo.cloud.databricks.com")
    if conn and not demo:
        checks.append(_check("deployment", "Deployment Ready", "pass", f"Deploying to {conn.config.get('host')} ({conn.name})."))
    elif s.databricks_host and s.databricks_token:
        checks.append(_check("deployment", "Deployment Ready", "pass", f"Workspace {s.databricks_host} is connected."))
    else:
        checks.append(_check("deployment", "Deployment Ready", "info",
                             "No Databricks workspace connected — deployment will run in safe simulation mode. Add a Databricks connection and choose 'Deploy EasyETL pipelines to this workspace'."))

    fails = sum(1 for c in checks if c["status"] == "fail")
    warns = sum(1 for c in checks if c["status"] == "warn")
    score = max(0, 100 - fails * 15 - warns * 5)
    return HealthCheckResult(ran_at=now_iso(), ready=fails == 0, score=score, checks=checks)
