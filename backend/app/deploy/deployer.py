"""Deployment abstraction.

`DatabricksDeployer` talks to a real workspace through the Databricks REST APIs (Workspace, Pipelines, Jobs,
SQL Statement Execution for Unity Catalog). `SimulatedDeployer` runs the identical step sequence in safe
mock mode when no workspace is connected — so the product is fully demonstrable and the real integration
plugs in without any change to the application.
"""
from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timezone
from typing import Any, Protocol

from ..core.config import get_settings
from ..core.errors import friendly_from_exception
from ..core.storage import get_storage
from ..engine.metadata import DeploymentState, PipelineMetadata
from .bundle import build_bundle, slug

STEPS = [
    ("validate", "Validating pipeline metadata"),
    ("generate", "Generating Databricks bundle"),
    ("unity_catalog", "Creating Unity Catalog catalog & schemas"),
    ("upload", "Uploading runtime and configuration"),
    ("pipeline", "Creating Lakeflow Declarative Pipeline"),
    ("job", "Creating orchestration job & schedule"),
    ("governance", "Applying governance (grants, tags, column masks)"),
    ("first_run", "Starting the first run"),
]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Deployer(Protocol):
    mode: str

    def deploy(self, pipeline_id: str, meta: PipelineMetadata, target: str) -> DeploymentState: ...


def _save_artifacts(pipeline_id: str, files: dict[str, str]) -> str:
    storage = get_storage()
    prefix = f"bundles/{pipeline_id}"
    storage.delete(prefix)
    import io

    for path, content in files.items():
        storage.put(f"{prefix}/{path}", io.BytesIO(content.encode()))
    return prefix


def dq_resources(meta: PipelineMetadata) -> list[dict[str, Any]]:
    """Quarantine / results / score tables created for each Silver table that has rules."""
    lh, schema = meta.lakehouse, meta.quality.dq_schema
    out: list[dict[str, Any]] = []
    for t in lh.tables:
        if t.layer != "silver" or not t.enabled:
            continue
        rules = [r for r in meta.quality_rules if r.enabled and r.dataset_id in t.source_datasets]
        if not rules:
            continue
        if any(r.action() == "quarantine" for r in rules):
            out.append({"type": "table", "layer": "dq", "name": f"{lh.catalog}.{schema}.{t.name}_quarantine"})
        out += [{"type": "table", "layer": "dq", "name": f"{lh.catalog}.{schema}.{t.name}_dq_results"},
                {"type": "table", "layer": "dq", "name": f"{lh.catalog}.{schema}.{t.name}_dq_score"}]
    return out


def target_resources(meta: PipelineMetadata) -> list[dict[str, Any]]:
    return [{"type": "target", "name": f"{t.name or t.connector} → {t.destination or 'default'} ({t.mode})", "id": t.id}
            for t in meta.targets if t.enabled]


class SimulatedDeployer:
    mode = "mock"
    secret_values: dict[str, str] = {}
    connections: dict[str, dict] = {}

    def deploy(self, pipeline_id: str, meta: PipelineMetadata, target: str) -> DeploymentState:
        files = build_bundle(meta, target, self.connections)
        prefix = _save_artifacts(pipeline_id, files)
        h = hashlib.sha1(pipeline_id.encode()).hexdigest()
        name = slug(meta)
        lh = meta.lakehouse
        resources = [
            {"type": "catalog", "name": lh.catalog, "id": lh.catalog},
            *[{"type": "schema", "name": f"{lh.catalog}.{s}"} for s in (lh.bronze_schema, lh.silver_schema, lh.gold_schema)],
            {"type": "pipeline", "name": f"[EasyETL] {meta.name}", "id": f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"},
            {"type": "job", "name": f"[EasyETL] {meta.name} — orchestration", "id": str(int(h[:10], 16) % 10**15)},
            *[{"type": "table", "layer": t.layer, "name": f"{lh.catalog}.{ {'bronze': lh.bronze_schema, 'silver': lh.silver_schema, 'gold': lh.gold_schema}[t.layer]}.{t.name}"}
              for t in lh.tables if t.enabled],
            *dq_resources(meta),
            *target_resources(meta),
            *([{"type": "secret_scope", "name": "easyetl", "id": f"{len(self.secret_values)} target secrets"}] if self.secret_values else []),
            {"type": "bundle", "name": name, "path": prefix, "files": sorted(files)},
        ]
        log = [{"step": k, "label": label, "status": "succeeded", "at": _now(), "simulated": True} for k, label in STEPS]
        return DeploymentState(status="deployed", mode="mock", target_environment=target, workspace_url="https://simulated.cloud.databricks.com",
                               deployed_at=_now(), resources=resources, log=log)


class DatabricksDeployer:
    """Real deployment via Databricks REST APIs."""

    mode = "databricks"

    def __init__(self, host: str, token: str | None = None, warehouse_id: str | None = None, headers: dict[str, str] | None = None,
                 auth_label: str = "Personal access token"):
        import httpx

        self.host = host.rstrip("/")
        self.client = httpx.Client(base_url=self.host, headers=headers or {"Authorization": f"Bearer {token}"}, timeout=60)
        self.warehouse_id = warehouse_id
        self.auth_label = auth_label
        self.secret_values: dict[str, str] = {}
        self.connections: dict[str, dict] = {}

    def _post(self, path: str, body: dict) -> dict:
        r = self.client.post(path, json=body)
        r.raise_for_status()
        return r.json() if r.content else {}

    def _sql(self, statement: str) -> None:
        if not self.warehouse_id:
            wh = self.client.get("/api/2.0/sql/warehouses").json().get("warehouses", [])
            if not wh:
                raise RuntimeError("No SQL warehouse available to apply Unity Catalog settings")
            self.warehouse_id = wh[0]["id"]
        res = self._post("/api/2.0/sql/statements", {"warehouse_id": self.warehouse_id, "statement": statement, "wait_timeout": "30s"})
        if res.get("status", {}).get("state") == "FAILED":
            raise RuntimeError(res["status"].get("error", {}).get("message", "SQL statement failed"))

    def deploy(self, pipeline_id: str, meta: PipelineMetadata, target: str) -> DeploymentState:
        state = DeploymentState(status="deploying", mode="databricks", target_environment=target, workspace_url=self.host)
        name = slug(meta)
        root = f"/Workspace/Shared/easyetl/{target}/{name}"
        step = "validate"
        try:
            state.log.append({"step": "validate", "label": STEPS[0][1], "status": "succeeded", "at": _now()})
            step = "generate"
            files = build_bundle(meta, target, self.connections)
            _save_artifacts(pipeline_id, files)
            state.log.append({"step": step, "label": STEPS[1][1], "status": "succeeded", "at": _now()})

            step = "unity_catalog"
            lh = meta.lakehouse
            for stmt in [f"CREATE CATALOG IF NOT EXISTS {lh.catalog}"] + [f"CREATE SCHEMA IF NOT EXISTS {lh.catalog}.{s}" for s in (lh.bronze_schema, lh.silver_schema, lh.gold_schema, meta.quality.dq_schema)] \
                    + [f"CREATE VOLUME IF NOT EXISTS {lh.catalog}.{lh.bronze_schema}.landing"]:
                self._sql(stmt)
            state.log.append({"step": step, "label": STEPS[2][1], "status": "succeeded", "at": _now()})

            step = "upload"
            for d in ("src", "config"):
                self._post("/api/2.0/workspace/mkdirs", {"path": f"{root}/{d}"})
            if self.secret_values:  # target credentials → Databricks secret scope, never into files
                scope = self.client.post("/api/2.0/secrets/scopes/create", json={"scope": "easyetl"})
                if scope.status_code >= 400 and "RESOURCE_ALREADY_EXISTS" not in scope.text:
                    scope.raise_for_status()
                for key, value in self.secret_values.items():
                    self._post("/api/2.0/secrets/put", {"scope": "easyetl", "key": key, "string_value": value})
            for path in [p for p in ("src/easyetl_pipeline.py", "src/easyetl_runtime.py", "src/easyetl_targets.py", "src/easyetl_publish.py", "config/pipeline_spec.json") if p in files]:
                self._post("/api/2.0/workspace/import", {"path": f"{root}/{path}", "format": "AUTO", "overwrite": True,
                                                          "content": base64.b64encode(files[path].encode()).decode()})
            state.log.append({"step": step, "label": STEPS[3][1], "status": "succeeded", "at": _now()})

            step = "pipeline"
            conf = {"easyetl.spec_path": f"{root}/config/pipeline_spec.json", "easyetl.landing_path": f"/Volumes/{lh.catalog}/{lh.bronze_schema}/landing/{name}",
                    "easyetl.hash_salt": "{{secrets/easyetl/hash_salt}}", "easyetl.aes_key": "{{secrets/easyetl/aes_key}}"}
            body = {"name": f"[EasyETL] {meta.name}", "catalog": lh.catalog, "schema": lh.silver_schema, "serverless": meta.ingestion.compute == "serverless",
                    "continuous": meta.ingestion.frequency == "continuous", "photon": True, "channel": "CURRENT", "configuration": conf,
                    "libraries": [{"file": {"path": f"{root}/src/easyetl_pipeline.py"}}], "development": target == "development"}
            existing = next((r for r in meta.deployment.resources if r.get("type") == "pipeline" and meta.deployment.mode == "databricks"), None)
            if existing:
                self.client.put(f"/api/2.0/pipelines/{existing['id']}", json={**body, "id": existing["id"]}).raise_for_status()
                pipeline_rid = existing["id"]
            else:
                pipeline_rid = self._post("/api/2.0/pipelines", body)["pipeline_id"]
            state.resources.append({"type": "pipeline", "name": body["name"], "id": pipeline_rid, "url": f"{self.host}/pipelines/{pipeline_rid}"})
            state.log.append({"step": step, "label": STEPS[4][1], "status": "succeeded", "at": _now()})

            step = "job"
            from .bundle import _cron

            cron = _cron(meta)
            job_body = {"name": f"[EasyETL] {meta.name} — orchestration", "max_concurrent_runs": 1,
                        "tasks": [{"task_key": "refresh_pipeline", "pipeline_task": {"pipeline_id": pipeline_rid}, "max_retries": meta.ingestion.retries,
                                   "min_retry_interval_millis": meta.ingestion.retry_delay_minutes * 60_000}],
                        "tags": {"managed_by": "easyetl"}}
            if meta.targets:
                job_body["tasks"].append({"task_key": "publish_targets", "depends_on": [{"task_key": "refresh_pipeline"}], "environment_key": "default",
                                          "spark_python_task": {"python_file": f"{root}/src/easyetl_publish.py", "parameters": [f"{root}/config/pipeline_spec.json"]},
                                          "max_retries": meta.ingestion.retries})
                job_body["environments"] = [{"environment_key": "default", "spec": {"client": "1", "dependencies": ["requests"]}}]
            if cron:
                job_body["schedule"] = {"quartz_cron_expression": cron, "timezone_id": "UTC", "pause_status": "UNPAUSED"}
            job_id = self._post("/api/2.1/jobs/create", job_body)["job_id"]
            state.resources.append({"type": "job", "name": job_body["name"], "id": str(job_id), "url": f"{self.host}/jobs/{job_id}"})
            state.log.append({"step": step, "label": STEPS[5][1], "status": "succeeded", "at": _now()})

            step = "governance"
            if meta.governance.unity_catalog:
                from .bundle import governance_sql

                for stmt in [s for s in governance_sql(meta).split(";\n") if s.strip() and not s.strip().startswith("--")]:
                    if "ALTER TABLE" in stmt:
                        continue  # table-level tags/masks are applied by the first successful pipeline update
                    self._sql(stmt.strip().rstrip(";"))
            state.log.append({"step": step, "label": STEPS[6][1], "status": "succeeded", "at": _now()})

            step = "first_run"
            run = self._post("/api/2.1/jobs/run-now", {"job_id": job_id})
            state.log.append({"step": step, "label": STEPS[7][1], "status": "succeeded", "at": _now(), "run_id": run.get("run_id")})
            state.status, state.deployed_at = "deployed", _now()
        except Exception as e:  # noqa: BLE001
            f = friendly_from_exception(e, context="Deployment to Databricks failed")
            state.status = "failed"
            state.error = {"step": step, "title": f.title, "message": f.message, "technical": f.technical}
            state.log.append({"step": step, "label": dict(STEPS)[step], "status": "failed", "at": _now()})
        return state


def deployment_connection(db: Any, tenant_id: str) -> Any:
    """The tenant's Databricks connection marked 'Deploy EasyETL pipelines to this workspace', if any."""
    from sqlalchemy import select

    from ..core.models import Connection

    rows = db.scalars(select(Connection).where(Connection.tenant_id == tenant_id, Connection.connector == "databricks")).all()
    return next((c for c in rows if (c.config or {}).get("use_for_deployment")), None)


def get_deployer(db: Any = None, tenant_id: str | None = None) -> Any:
    """A saved Databricks connection (any auth method) wins; then EASYETL_DATABRICKS_HOST/TOKEN; else simulation."""
    if db is not None and tenant_id:
        conn = deployment_connection(db, tenant_id)
        if conn and (conn.config.get("host") or "").strip().lower() not in ("", "demo", "demo.cloud.databricks.com"):
            from ..core.security import SecretStore
            from .databricks_auth import METHODS, auth_headers, normalize_host, warehouse_id_from

            secrets = SecretStore(db, tenant_id).get(conn.secret_ref)
            method = conn.config.get("auth_method") or "pat"
            host = normalize_host(conn.config["host"])
            return DatabricksDeployer(host, headers=auth_headers(host, method, conn.config, secrets), warehouse_id=warehouse_id_from(conn.config),
                                      auth_label=METHODS.get(method, method))
    s = get_settings()
    if s.databricks_host and s.databricks_token:
        return DatabricksDeployer(s.databricks_host, s.databricks_token)
    return SimulatedDeployer()

