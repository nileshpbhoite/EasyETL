"""Databricks as a source, a target, and the deployment workspace.

Connection types
    workspace      Workspace REST APIs (Unity Catalog, Jobs, Lakeflow pipelines) — enough to deploy
    sql_warehouse  A SQL warehouse (the "HTTP path" from its Connection details) — also reads/writes table data
    cluster        An all-purpose cluster (Databricks Connect / JDBC on a cluster)
    serverless     Serverless compute

All REST traffic authenticates through `deploy.databricks_auth` (PAT, OAuth M2M, Entra ID, managed identity,
Azure CLI, GCP service account or a CLI profile). host='demo' gives a simulated workspace with sample tables.
"""
from __future__ import annotations

import random
import time
import zlib
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import polars as pl

from ..deploy.databricks_auth import DatabricksAuthError, auth_headers, normalize_host, warehouse_id_from
from ..engine.metadata import DatasetRef
from .base import AuthMethod, Connector, ConnectorSpec, FieldSpec, TestResult

_DEMO_TABLES = [
    ("main.sales.customers", ["customer_id", "first_name", "last_name", "email", "phone", "country", "updated_at"], 18400),
    ("main.sales.orders", ["order_id", "customer_id", "order_date", "amount", "currency", "status", "updated_at"], 96000),
    ("main.sales.products", ["product_id", "name", "category", "list_price", "is_active", "updated_at"], 1450),
    ("main.finance.invoices", ["invoice_id", "customer_id", "invoice_date", "amount", "due_date", "status", "updated_at"], 31000),
]

_SHOW = lambda **kw: kw  # noqa: E731 — readability helper for show_if

SPEC = ConnectorSpec(
    id="databricks", name="Databricks", category="warehouse", icon="layers", color="#ff3621",
    description="Unity Catalog tables in any Databricks workspace. Also the deployment target for pipelines.",
    auth_methods=[
        AuthMethod(id="pat", label="Personal access token", fields=[
            FieldSpec(name="token", label="Personal access token", type="password", secret=True, required=True, placeholder="dapi…",
                      help="User settings → Developer → Access tokens. Prefer a service principal for production.")]),
        AuthMethod(id="oauth_m2m", label="OAuth service principal (M2M)", fields=[
            FieldSpec(name="client_id", label="Client ID (application ID)", required=True),
            FieldSpec(name="client_secret", label="OAuth secret", type="password", secret=True, required=True,
                      help="Created under the service principal's Secrets tab. Recommended for production.")]),
        AuthMethod(id="azure_sp", label="Microsoft Entra ID service principal", fields=[
            FieldSpec(name="tenant_id", label="Tenant (directory) ID", required=True),
            FieldSpec(name="client_id", label="Client (application) ID", required=True),
            FieldSpec(name="client_secret", label="Client secret", type="password", secret=True, required=True)]),
        AuthMethod(id="azure_msi", label="Azure managed identity", fields=[
            FieldSpec(name="client_id", label="Client ID (user-assigned identity only)",
                      help="Leave empty for the system-assigned identity of the machine running EasyETL.")]),
        AuthMethod(id="azure_cli", label="Azure CLI (az login on the server)", fields=[]),
        AuthMethod(id="gcp_sa", label="Google Cloud service account", fields=[
            FieldSpec(name="service_account_json", label="Service account key (JSON)", type="password", secret=True, required=True)]),
        AuthMethod(id="cli_profile", label="Databricks CLI profile (~/.databrickscfg)", fields=[
            FieldSpec(name="profile", label="Profile name", default="DEFAULT")]),
    ],
    config_fields=[
        FieldSpec(name="host", label="Workspace URL", type="url", required=True, placeholder="https://adb-1234567890123456.7.azuredatabricks.net",
                  help="Tip: enter 'demo' to explore a simulated workspace."),
        FieldSpec(name="connection_type", label="Connect through", type="select", default="sql_warehouse", options=[
            {"value": "sql_warehouse", "label": "SQL warehouse (read & write tables)"},
            {"value": "workspace", "label": "Workspace APIs only (deploy pipelines)"},
            {"value": "cluster", "label": "All-purpose cluster (Databricks Connect)"},
            {"value": "serverless", "label": "Serverless compute"}]),
        FieldSpec(name="http_path", label="SQL warehouse HTTP path", placeholder="/sql/1.0/warehouses/abc123def456",
                  help="SQL Warehouses → your warehouse → Connection details.", show_if=_SHOW(connection_type=["sql_warehouse"])),
        FieldSpec(name="cluster_id", label="Cluster ID", placeholder="0123-456789-abcdefgh", show_if=_SHOW(connection_type=["cluster"])),
        FieldSpec(name="catalog", label="Catalog", default="main"),
        FieldSpec(name="schema", label="Schema", placeholder="All schemas", advanced=True),
        FieldSpec(name="use_for_deployment", label="Deploy EasyETL pipelines to this workspace", type="boolean", default=False,
                  help="Replaces simulation mode: deployments create real Unity Catalog objects, Lakeflow pipelines and jobs here."),
    ],
    supports_cdc=True, recommended_ingestion="batch", object_label="tables", demo_hint="demo",
    roles=["source", "target"], target_modes=["append", "overwrite", "merge"],
    target_note="Writes Delta tables into Unity Catalog (MERGE on business keys for upserts).",
)


class DatabricksConnector(Connector):
    spec = SPEC

    # ---------------------------------------------------------------- plumbing
    def is_demo(self) -> bool:
        return (self.config.get("host") or "").strip().lower() in ("demo", "demo.cloud.databricks.com")

    @property
    def host(self) -> str:
        return normalize_host(self.config.get("host", ""))

    def headers(self) -> dict[str, str]:
        return auth_headers(self.host, self.config.get("auth_method") or "pat", self.config, self.secrets)

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=self.host, headers=self.headers(), timeout=60)

    def warehouse_id(self) -> str | None:
        return warehouse_id_from(self.config)

    # ---------------------------------------------------------------- SDK
    def test_connection(self) -> TestResult:
        ctype = self.config.get("connection_type") or "sql_warehouse"
        if self.is_demo():
            return TestResult(ok=True, title="Connection successful", message="Connected to the simulated Databricks workspace.", info={
                "Workspace": "demo.cloud.databricks.com (simulated)", "Signed in as": "service-principal@easyetl",
                "Authentication": self._auth_label(), "Unity Catalog": "Enabled · metastore 'demo'",
                "Compute": {"sql_warehouse": "Serverless SQL warehouse 'Starter' (running)", "cluster": "Cluster 'Shared' (running)",
                            "serverless": "Serverless", "workspace": "—"}[ctype], "Tables available": len(_DEMO_TABLES)})
        if not self.host:
            return TestResult(ok=False, title="Workspace URL missing", message="Enter your workspace URL, e.g. https://adb-123.azuredatabricks.net.")
        try:
            with self._client() as c:
                me = c.get("/api/2.0/preview/scim/v2/Me")
                if me.status_code in (401, 403):
                    return TestResult(ok=False, title="Access denied", message="Databricks rejected these credentials. Check the token or service principal permissions.",
                                      technical=me.text[:500])
                me.raise_for_status()
                info: dict[str, Any] = {"Workspace": self.host, "Signed in as": me.json().get("userName") or me.json().get("displayName"),
                                        "Authentication": self._auth_label()}
                ms = c.get("/api/2.1/unity-catalog/current-metastore-assignment")
                info["Unity Catalog"] = f"Enabled · default catalog '{ms.json().get('default_catalog_name', 'main')}'" if ms.status_code == 200 else "Not assigned"
                if ctype == "sql_warehouse":
                    wid = self.warehouse_id()
                    if not wid:
                        return TestResult(ok=False, title="HTTP path missing", message="Enter the SQL warehouse HTTP path (Connection details tab).", info=info)
                    wh = c.get(f"/api/2.0/sql/warehouses/{wid}")
                    if wh.status_code == 404:
                        return TestResult(ok=False, title="Warehouse not found", message=f"No SQL warehouse with id '{wid}' in this workspace.", info=info)
                    wh.raise_for_status()
                    info["Compute"] = f"SQL warehouse '{wh.json().get('name')}' ({wh.json().get('state', '').lower()})"
                elif ctype == "cluster":
                    cl = c.get("/api/2.0/clusters/get", params={"cluster_id": self.config.get("cluster_id", "")})
                    if cl.status_code >= 400:
                        return TestResult(ok=False, title="Cluster not found", message="Check the cluster ID.", info=info, technical=cl.text[:300])
                    info["Compute"] = f"Cluster '{cl.json().get('cluster_name')}' ({cl.json().get('state', '').lower()})"
                else:
                    info["Compute"] = "Serverless" if ctype == "serverless" else "Workspace APIs"
                return TestResult(ok=True, title="Connection successful", message="Connected to Databricks.", info=info)
        except DatabricksAuthError as e:
            return TestResult(ok=False, title="Couldn't sign in", message=str(e))
        except httpx.HTTPError as e:
            return TestResult(ok=False, title="Connection failed", message=f"We couldn't reach {self.host}. Check the workspace URL and network access.", technical=str(e))

    def _auth_label(self) -> str:
        from ..deploy.databricks_auth import METHODS

        return METHODS.get(self.config.get("auth_method") or "pat", "Personal access token")

    def discover(self) -> list[DatasetRef]:
        if self.is_demo():
            return [DatasetRef(name=n, kind="table", format="delta", locator={"full_name": n}, row_count=r, column_count=len(c),
                               columns=[{"name": x} for x in c], selected=i < 2, incremental_field="updated_at", cdc_capable=True,
                               modified_at=(datetime.now(timezone.utc) - timedelta(hours=i * 5)).isoformat())
                    for i, (n, c, r) in enumerate(_DEMO_TABLES)]
        catalog = self.config.get("catalog") or "main"
        out: list[DatasetRef] = []
        with self._client() as c:
            schemas = [self.config["schema"]] if self.config.get("schema") else [
                s["name"] for s in c.get("/api/2.1/unity-catalog/schemas", params={"catalog_name": catalog}).json().get("schemas", [])
                if s["name"] != "information_schema"]
            for schema in schemas[:25]:
                res = c.get("/api/2.1/unity-catalog/tables", params={"catalog_name": catalog, "schema_name": schema, "max_results": 200})
                for t in res.json().get("tables", []):
                    cols = [{"name": col["name"], "type": col.get("type_text")} for col in t.get("columns", [])]
                    ds = DatasetRef(name=t["full_name"], kind="table", format="delta", locator={"full_name": t["full_name"]},
                                    column_count=len(cols), columns=cols, selected=False,
                                    modified_at=datetime.fromtimestamp((t.get("updated_at") or 0) / 1000, timezone.utc).isoformat())
                    ds.incremental_field = self.detect_incremental(ds)
                    out.append(ds)
        return out

    def read(self, dataset: DatasetRef, limit: int | None = None) -> pl.DataFrame:
        full = dataset.locator["full_name"]
        if self.is_demo():
            from .impl import _saas_value

            cols, rows = next((c, r) for n, c, r in _DEMO_TABLES if n == full)
            n = min(rows, limit or rows)
            rng = random.Random(zlib.crc32(full.encode()))
            return pl.DataFrame({c: [_saas_value(c, i, rng) for i in range(n)] for c in cols}, schema={c: pl.Utf8 for c in cols})
        wid = self.warehouse_id()
        if not wid:
            from ..core.errors import FriendlyError

            raise FriendlyError("SQL warehouse needed", "Reading Databricks tables needs a SQL warehouse. Edit the connection and add its HTTP path.")
        ident = ".".join(f"`{p.replace('`', '``')}`" for p in full.split("."))
        stmt = f"SELECT * FROM {ident}" + (f" LIMIT {int(limit)}" if limit else "")
        with self._client() as c:
            res = c.post("/api/2.0/sql/statements", json={"warehouse_id": wid, "statement": stmt, "wait_timeout": "50s",
                                                         "disposition": "INLINE", "format": "JSON_ARRAY"}).json()
            deadline = time.time() + 120
            while res.get("status", {}).get("state") in ("PENDING", "RUNNING") and time.time() < deadline:
                time.sleep(2)
                res = c.get(f"/api/2.0/sql/statements/{res['statement_id']}").json()
        if res.get("status", {}).get("state") != "SUCCEEDED":
            raise RuntimeError(res.get("status", {}).get("error", {}).get("message", "Query failed"))
        cols = [col["name"] for col in res["manifest"]["schema"]["columns"]]
        rows = res.get("result", {}).get("data_array") or []
        return pl.DataFrame({c: [r[i] for r in rows] for i, c in enumerate(cols)}, schema={c: pl.Utf8 for c in cols})

    def read_metadata(self) -> dict[str, Any]:
        return {"host": self.host, "demo": self.is_demo(), "warehouse_id": self.warehouse_id()}
