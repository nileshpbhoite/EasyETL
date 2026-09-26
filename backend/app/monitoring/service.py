"""Pipeline monitoring + AI continuous monitoring (anomaly detection).

Run history comes from the Databricks Jobs API for live deployments. In simulation mode a deterministic
scheduler produces realistic runs (including the occasional anomaly) so monitoring and AI alerts can be
demonstrated end-to-end. Anomaly detection is the same in both modes: robust statistics over a baseline.
"""
from __future__ import annotations

import hashlib
import random
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.models import Pipeline, PipelineRun
from ..engine.health import estimate_cost
from ..engine.metadata import PipelineMetadata

INTERVALS = {"continuous": timedelta(minutes=30), "every_15_min": timedelta(minutes=15), "hourly": timedelta(hours=1),
             "daily": timedelta(days=1), "weekly": timedelta(days=7), "manual": timedelta(days=1)}
HISTORY_DAYS = 14
MAX_RUNS = 240


def _utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _seed(pipeline_id: str, extra: str = "") -> int:
    return int(hashlib.sha1((pipeline_id + extra).encode()).hexdigest()[:8], 16)


def _baseline(meta: PipelineMetadata) -> dict[str, float]:
    rows = sum(d.row_count or 0 for d in meta.selected_datasets()) or 1000
    per_run = rows if meta.ingestion.mode == "full" else max(int(rows * 0.08), 150)
    if meta.ingestion.frequency in ("hourly", "every_15_min", "continuous"):
        per_run = max(int(per_run / 12), 60)
    profiles = meta.analysis.profiles.values()
    after = [q["quality_score"] for q in meta.analysis.quality_after.values()]
    quality = statistics.mean(after) if after else (statistics.mean([p["quality"]["score"] for p in profiles]) if profiles else 90.0)
    steps = sum(1 for t in meta.transformations if t.enabled)
    cost = estimate_cost(meta)
    return {"records": per_run, "duration": 45 + per_run / 900 + steps * 2.5, "quality": quality,
            "cost": cost["compute_usd"] / max(cost["runs_per_month"], 1), "storage": max(cost["storage_gb"], 0.01)}


def _make_run(pipeline_id: str, meta: PipelineMetadata, at: datetime, idx: int, base: dict, anomaly: str | None = None) -> PipelineRun:
    rng = random.Random(_seed(pipeline_id, at.isoformat()))
    hour_factor = 1.0 + 0.25 * (1 if 8 <= at.hour <= 18 else -0.4) if meta.ingestion.frequency in ("hourly", "every_15_min") else 1.0
    records = int(base["records"] * hour_factor * rng.uniform(0.88, 1.12))
    duration = base["duration"] * rng.uniform(0.85, 1.2) * (0.6 + 0.4 * records / max(base["records"], 1))
    quality = min(100.0, base["quality"] + rng.uniform(-0.8, 0.6))
    failed_records = int(records * rng.uniform(0.001, 0.006))
    status = "succeeded"
    schema = "v1"
    details: dict[str, Any] = {"layers": {}}
    if anomaly == "volume_drop":
        records = int(records * 0.58)
    elif anomaly == "volume_spike":
        records = int(records * 1.28)
    elif anomaly == "slow":
        duration *= 2.6
    elif anomaly == "quality":
        quality -= 9.5
        failed_records = int(records * 0.07)
    elif anomaly == "failed":
        status = "failed"
        details["error"] = {"title": "Source file couldn't be read", "message": "The landing folder contained a file with an unexpected format. It was quarantined.",
                            "technical": "org.apache.spark.SparkException: [MALFORMED_RECORD_IN_PARSING] Malformed records are detected in record parsing."}
    if anomaly in ("schema",) or (anomaly is None and idx > 0 and details.get("schema_changed")):
        schema = "v2"
        details["schema_change"] = {"added": ["loyalty_tier"], "removed": [], "type_changed": []}
    bronze = records
    silver = int(records * (1 - failed_records / max(records, 1)) * 0.985)
    gold = max(int(silver * 0.12), 1)
    details["layers"] = {"source": records, "bronze": bronze, "silver": silver if status == "succeeded" else 0, "gold": gold if status == "succeeded" else 0}
    details["anomaly_injected"] = anomaly
    return PipelineRun(pipeline_id=pipeline_id, status=status, started_at=at, duration_seconds=round(duration, 1),
                       records_ingested=records if status == "succeeded" else 0, failed_records=failed_records, quality_score=round(quality, 1),
                       cost_usd=round(base["cost"] * rng.uniform(0.9, 1.15) * (duration / base["duration"]), 4),
                       storage_gb=round(base["storage"] * (1 + idx * 0.004), 4), schema_hash=schema, details=details)


def ensure_runs(db: Session, row: Pipeline, meta: PipelineMetadata) -> None:
    """Simulated scheduler: backfill history on first deploy, then add runs that 'happened' since the last visit."""
    if meta.deployment.status != "deployed" or meta.deployment.mode != "mock" or row.status == "paused":
        return
    interval = INTERVALS[meta.ingestion.frequency]
    now = datetime.now(timezone.utc)
    last = db.scalars(select(PipelineRun).where(PipelineRun.pipeline_id == row.id).order_by(PipelineRun.started_at.desc()).limit(1)).first()
    base = _baseline(meta)
    count = db.query(PipelineRun).filter(PipelineRun.pipeline_id == row.id).count()
    if last is None:
        deployed = datetime.fromisoformat(meta.deployment.deployed_at) if meta.deployment.deployed_at else now
        start = _utc(deployed) - timedelta(days=HISTORY_DAYS)
        times = []
        t = start
        while t <= now and len(times) < 10_000:
            times.append(t)
            t += interval
        times = times[-MAX_RUNS:]
        s = _seed(row.id)
        n = len(times)
        anomalies: dict[int, str] = {}
        if n > 8:
            anomalies[n - 1] = ["volume_drop", "quality", "volume_drop", "slow"][s % 4]
            anomalies[max(1, n // 3)] = "failed"
            anomalies[max(2, (2 * n) // 3)] = "schema" if s % 2 == 0 else "volume_spike"
        runs = [_make_run(row.id, meta, ts, i, base, anomalies.get(i)) for i, ts in enumerate(times)]
        # carry schema v2 forward after a schema change
        changed = False
        for r in runs:
            if r.details.get("schema_change"):
                changed = True
            elif changed:
                r.schema_hash = "v2"
        db.add_all(runs)
        db.commit()
        return
    t = _utc(last.started_at) + interval
    new = []
    while t <= now and len(new) < MAX_RUNS:
        new.append(_make_run(row.id, meta, t, count + len(new), base))
        t += interval
    for r in new:
        r.schema_hash = last.schema_hash
    if new:
        db.add_all(new)
        db.commit()


def runs_for(db: Session, pipeline_id: str, limit: int = 240) -> list[PipelineRun]:
    return list(reversed(db.scalars(select(PipelineRun).where(PipelineRun.pipeline_id == pipeline_id).order_by(PipelineRun.started_at.desc()).limit(limit)).all()))


def run_dict(r: PipelineRun) -> dict:
    return {"id": r.id, "status": r.status, "started_at": _utc(r.started_at).isoformat(), "duration_seconds": r.duration_seconds,
            "records_ingested": r.records_ingested, "failed_records": r.failed_records, "quality_score": r.quality_score,
            "cost_usd": r.cost_usd, "storage_gb": r.storage_gb, "schema_hash": r.schema_hash, "details": r.details}


# ------------------------------------------------------------------ anomaly detection
def _robust_z(value: float, baseline: list[float]) -> tuple[float, float]:
    med = statistics.median(baseline)
    mad = statistics.median([abs(x - med) for x in baseline]) or (abs(med) * 0.05) or 1.0
    return (value - med) / (1.4826 * mad), med


def detect_anomalies(meta: PipelineMetadata, runs: list[PipelineRun], paused: bool = False) -> list[dict]:
    alerts: list[dict] = []
    ok_runs = [r for r in runs if r.status == "succeeded"]
    if len(runs) < 5:
        return alerts
    latest = runs[-1]
    history = [r for r in ok_runs[:-1]][-48:]
    interval = INTERVALS[meta.ingestion.frequency]
    source = meta.selected_datasets()[0].name if meta.selected_datasets() else "Source"
    entity = next(iter(meta.analysis.entities.values()), "record").title()

    def add(kind: str, severity: str, title: str, detail: str, recommendation: str, metric: str | None = None, change: float | None = None, run: PipelineRun | None = None):
        alerts.append({"id": f"{kind}-{(run or latest).id}", "kind": kind, "severity": severity, "title": title, "detail": detail, "recommendation": recommendation,
                       "metric": metric, "change_pct": round(change, 1) if change is not None else None,
                       "detected_at": _utc((run or latest).started_at).isoformat()})

    if latest.status == "failed":
        err = latest.details.get("error", {})
        add("failure", "critical", f"The latest run failed: {err.get('title', 'unknown error')}", err.get("message", ""),
            "Open the quarantined file, fix or remove it, then re-run. Bronze data from earlier runs is unaffected.", run=latest)
    elif len(history) >= 5:
        z, med = _robust_z(latest.records_ingested, [r.records_ingested for r in history])
        change = (latest.records_ingested - med) / med * 100 if med else 0
        if z < -3 and change < -20:
            add("volume", "warning", f"{entity} ingestion volume dropped {abs(change):.0f}% compared with the normal {'hourly' if interval <= timedelta(hours=1) else 'daily'} baseline.",
                f"{latest.records_ingested:,} records vs a typical {med:,.0f}.", f"Review today's {source} data before processing Silver.", "records", change)
        elif z > 3 and change > 20:
            add("volume", "info", f"This pipeline processed {change:.0f}% more data than normal.", f"{latest.records_ingested:,} records vs a typical {med:,.0f}.",
                "No action needed if a campaign or backfill is expected. Otherwise check the source for duplicate exports.", "records", change)
        zq, medq = _robust_z(latest.quality_score, [r.quality_score for r in history])
        if zq < -3 and latest.quality_score < medq - 3:
            add("quality", "warning", f"Data quality degraded to {latest.quality_score:.1f}% (normally {medq:.1f}%).",
                f"{latest.failed_records:,} records failed quality rules in the latest run.",
                "Open Data Quality to see which rules failed; the failing records are quarantined, not lost.", "quality", latest.quality_score - medq)
        zd, medd = _robust_z(latest.duration_seconds, [r.duration_seconds for r in history])
        if zd > 3.5 and latest.duration_seconds > medd * 1.6:
            add("performance", "warning", f"Processing took {latest.duration_seconds / medd:.1f}× longer than usual.",
                f"{latest.duration_seconds:.0f}s vs a typical {medd:.0f}s.", "Enable liquid clustering on the largest Silver table or move to a larger compute tier.",
                "duration", (latest.duration_seconds - medd) / medd * 100)
        zc, medc = _robust_z(latest.cost_usd, [r.cost_usd for r in history])
        if not any(a["kind"] == "performance" for a in alerts) and zc > 4 and latest.cost_usd > medc * 1.8:
            add("cost", "info", "Run cost is higher than usual.", f"${latest.cost_usd:.2f} vs a typical ${medc:.2f}.",
                "Check for full refreshes or reprocessing; incremental mode keeps cost predictable.", "cost", (latest.cost_usd - medc) / medc * 100)
    for prev, cur in zip(runs, runs[1:]):
        if cur.schema_hash != prev.schema_hash and cur.details.get("schema_change"):
            ch = cur.details["schema_change"]
            add("schema", "info", f"A schema change was detected in {source}.", f"New column(s): {', '.join(ch.get('added', []))}. Schema evolution added them to Bronze automatically.",
                "Decide whether the new column should flow to Silver — add it in Transformation Studio or leave it in Bronze only.", run=cur)
    for r in runs[-24:]:
        if r.status == "failed" and r is not latest:
            add("failure", "warning", "A run failed earlier and was retried successfully.", (r.details.get("error") or {}).get("message", ""),
                "No action needed — the automatic retry succeeded.", run=r)
            break
    if ok_runs and not paused:
        age = datetime.now(timezone.utc) - _utc(ok_runs[-1].started_at)
        if age > interval * 2.5 and meta.ingestion.frequency != "manual":
            add("freshness", "warning", "Data is stale.", f"The last successful load was {age.total_seconds() / 3600:.1f} hours ago.",
                "Check the job schedule and the source system availability.")
    order = {"critical": 0, "warning": 1, "info": 2}
    alerts.sort(key=lambda a: a["detected_at"], reverse=True)
    alerts.sort(key=lambda a: order[a["severity"]])
    return alerts


def summary(meta: PipelineMetadata, row: Pipeline, runs: list[PipelineRun]) -> dict:
    now = datetime.now(timezone.utc)
    interval = INTERVALS[meta.ingestion.frequency]
    if not runs:
        return {"status": "not_deployed" if meta.deployment.status != "deployed" else "starting"}
    latest = runs[-1]
    ok = [r for r in runs if r.status == "succeeded"]
    last_ok = ok[-1] if ok else None
    day = [r for r in runs if _utc(r.started_at) >= now - timedelta(days=1)]
    month = [r for r in runs if _utc(r.started_at) >= now - timedelta(days=30)]
    status = "paused" if row.status == "paused" else ("failed" if latest.status == "failed" else "running")
    return {
        "status": status,
        "last_run": run_dict(latest),
        "next_run": None if status == "paused" or meta.ingestion.frequency == "manual" else (_utc(latest.started_at) + interval).isoformat(),
        "records_last_run": latest.records_ingested,
        "records_24h": sum(r.records_ingested for r in day),
        "processing_seconds": latest.duration_seconds,
        "throughput_rps": round(latest.records_ingested / latest.duration_seconds, 1) if latest.duration_seconds else 0,
        "freshness_minutes": round(max(0.0, (now - _utc(last_ok.started_at)).total_seconds() / 60), 1) if last_ok else None,
        "quality_score": last_ok.quality_score if last_ok else None,
        "failed_records": latest.failed_records,
        "storage_gb": latest.storage_gb,
        "cost_mtd_usd": round(sum(r.cost_usd for r in month), 2),
        "success_rate": round(len([r for r in runs[-50:] if r.status == "succeeded"]) / len(runs[-50:]) * 100, 1),
        "layers": latest.details.get("layers", {}),
        "run_count": len(runs),
    }
