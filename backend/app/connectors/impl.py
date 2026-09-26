"""Concrete connectors: uploaded files, relational databases, REST/GraphQL APIs, SaaS applications, cloud storage."""
from __future__ import annotations

import json
import os
import random
import zlib
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import polars as pl

from ..engine.metadata import DatasetRef
from .base import AuthMethod, Connector, ConnectorSpec, FieldSpec, TestResult
from .files import detect_file, read_file_entry, records_to_frame

from ..demo.generate import FIRST as _FIRST, LAST as _LAST

DEMO_DIR = Path(__file__).resolve().parents[1] / "demo" / "data"


# ============================================================================ Files
class FileConnector(Connector):
    spec = ConnectorSpec(
        id="file_upload", name="File upload", category="file", icon="upload", color="#6366f1",
        description="Excel, CSV, JSON, XML, Parquet, Avro, TXT and ZIP files.",
        recommended_ingestion="auto_loader", object_label="files",
    )

    def _resolve(self, file_id: str) -> tuple[Path, str, dict]:
        resolver: Callable[[str], tuple[Path, str, dict]] = self.context["resolve_file"]
        return resolver(file_id)

    def test_connection(self) -> TestResult:
        ids = self.config.get("file_ids", [])
        return TestResult(ok=bool(ids), title="Files ready" if ids else "No files yet",
                          message=f"{len(ids)} file(s) uploaded." if ids else "Upload a file to continue.")

    def discover(self) -> list[DatasetRef]:
        out = []
        for fid in self.config.get("file_ids", []):
            path, filename, detection = self._resolve(fid)
            detection = detection or detect_file(path, filename)
            entries = [e for e in detection["entries"] if e.get("supported", True) and (e.get("row_count") or 0) > 0]
            for e in entries:
                base = Path(filename).stem
                name = base if len(entries) == 1 else f"{base} › {e['name']}"
                out.append(DatasetRef(
                    name=name, kind=e["kind"], format=e["format"], locator={"file_id": fid, **e["locator"]},
                    row_count=e.get("row_count"), column_count=e.get("column_count"), size_bytes=e.get("size_bytes") or detection["size_bytes"],
                    columns=[{"name": c} for c in e.get("columns", [])],
                    # the main sheet / largest entry is selected by default; tiny lookup sheets are optional
                    selected=(e.get("row_count") or 0) >= 50 or len(entries) == 1,
                    modified_at=datetime.now(timezone.utc).isoformat(),
                ))
        return out

    def read(self, dataset: DatasetRef, limit: int | None = None) -> pl.DataFrame:
        loc = dict(dataset.locator)
        path, filename, _ = self._resolve(loc.pop("file_id"))
        return read_file_entry(path, filename, loc, limit)

    def detect_incremental(self, dataset: DatasetRef) -> str | None:
        return super().detect_incremental(dataset)

    def detect_cdc(self, dataset: DatasetRef) -> bool:
        return False


# ============================================================================ Databases
_DB_DIALECTS = {
    "sqlserver": ("mssql+pyodbc", 1433, "SQL Server"),
    "postgresql": ("postgresql+psycopg", 5432, "PostgreSQL"),
    "mysql": ("mysql+pymysql", 3306, "MySQL"),
    "oracle": ("oracle+oracledb", 1521, "Oracle"),
    "jdbc": ("", 0, "JDBC"),
    "azure_sql": ("mssql+pyodbc", 1433, "Azure SQL Database"),
    "mariadb": ("mariadb+mariadbconnector", 3306, "MariaDB"),
    "db2": ("db2+ibm_db", 50000, "IBM Db2"),
    "teradata": ("teradatasql", 1025, "Teradata"),
    "sap_hana": ("hana", 39015, "SAP HANA"),
    "sybase": ("sybase+pyodbc", 5000, "SAP ASE (Sybase)"),
    "cockroachdb": ("cockroachdb", 26257, "CockroachDB"),
    "redshift": ("redshift+psycopg2", 5439, "Amazon Redshift"),
    "synapse": ("mssql+pyodbc", 1433, "Azure Synapse Analytics"),
}


def _db_spec(cid: str, name: str, color: str, cdc: bool, desc: str, category: str = "database") -> ConnectorSpec:
    port = _DB_DIALECTS[cid][1]
    return ConnectorSpec(
        id=cid, name=name, category=category, icon="warehouse" if category == "warehouse" else "database", color=color, description=desc,  # type: ignore[arg-type]
        roles=["source", "target"], target_modes=["append", "overwrite", "merge"],
        target_note="Writes curated tables over JDBC from Databricks (MERGE through a staging table for upserts).",
        auth_methods=[
            AuthMethod(id="password", label="Username & password", fields=[
                FieldSpec(name="username", label="Username", required=True),
                FieldSpec(name="password", label="Password", type="password", secret=True, required=True)]),
            AuthMethod(id="integrated", label="Managed identity / Kerberos", fields=[]),
        ],
        config_fields=[
            FieldSpec(name="host", label="Server address", required=True, placeholder="sql01.company.com",
                      help="Tip: enter 'demo' to explore the built-in dealership database."),
            FieldSpec(name="port", label="Port", type="number", default=port),
            FieldSpec(name="database", label="Database", required=True, placeholder="sales"),
            FieldSpec(name="schema", label="Schema", placeholder="dbo", advanced=True),
            FieldSpec(name="ssl", label="Encrypt connection (TLS)", type="boolean", default=True, advanced=True),
        ],
        supports_cdc=cdc, recommended_ingestion="lakeflow_connect" if cdc else "jdbc", demo_hint="demo",
    )


class DatabaseConnector(Connector):
    """Any SQLAlchemy/JDBC-compatible database. host='demo' uses the bundled dealership database through the
    exact same code path (SQLAlchemy inspector + SQL reads)."""

    dialect = "jdbc"

    def _url(self) -> str:
        host = (self.config.get("host") or "").strip()
        if host.lower() in ("demo", "demo.easyetl.local", "localhost-demo"):
            return f"sqlite:///{DEMO_DIR / 'demo_dealer_db.sqlite'}"
        if self.config.get("connection_url"):
            return self.config["connection_url"]
        driver, default_port, _ = _DB_DIALECTS[self.dialect]
        user = self.secrets.get("username") or self.config.get("username", "")
        pwd = self.secrets.get("password", "")
        port = self.config.get("port") or default_port
        from urllib.parse import quote_plus

        creds = f"{quote_plus(user)}:{quote_plus(pwd)}@" if user else ""
        extra = "?driver=ODBC+Driver+18+for+SQL+Server&TrustServerCertificate=yes" if driver == "mssql+pyodbc" else ""
        return f"{driver}://{creds}{host}:{port}/{self.config.get('database', '')}{extra}"

    def _engine(self):
        from sqlalchemy import create_engine

        return create_engine(self._url(), pool_pre_ping=True, connect_args={"timeout": 10} if self._url().startswith("sqlite") else {})

    def is_demo(self) -> bool:
        return self._url().startswith("sqlite")

    def test_connection(self) -> TestResult:
        from sqlalchemy import inspect, text

        try:
            eng = self._engine()
            with eng.connect() as con:
                con.execute(text("SELECT 1"))
            tables = inspect(eng).get_table_names(schema=self.config.get("schema") or None)
            label = _DB_DIALECTS[self.dialect][2]
            return TestResult(ok=True, title="Connection successful", message=f"Connected to {label}.", info={
                "Server": "Demo dealership database" if self.is_demo() else self.config.get("host"),
                "Database": self.config.get("database") or "dealer_dms",
                "Engine": label + (" (demo)" if self.is_demo() else ""),
                "Tables available": len(tables),
            })
        except ModuleNotFoundError as e:
            return TestResult(ok=False, title="Driver not installed",
                              message=f"The {_DB_DIALECTS[self.dialect][2]} driver isn't installed on this server. Ask your administrator to enable it.",
                              technical=str(e))
        except Exception as e:  # noqa: BLE001 — translated to a friendly message
            from ..core.errors import friendly_from_exception

            f = friendly_from_exception(e, context=f"We couldn't connect to {_DB_DIALECTS[self.dialect][2]}")
            return TestResult(ok=False, title="Connection failed", message=f.message, technical=f.technical)

    def discover(self) -> list[DatasetRef]:
        from sqlalchemy import func, inspect, select, table

        eng = self._engine()
        insp = inspect(eng)
        schema = self.config.get("schema") or None
        out = []
        with eng.connect() as con:
            for t in insp.get_table_names(schema=schema):
                cols = insp.get_columns(t, schema=schema)
                pk = insp.get_pk_constraint(t, schema=schema).get("constrained_columns", [])
                fks = insp.get_foreign_keys(t, schema=schema)
                count = con.execute(select(func.count()).select_from(table(t, schema=schema))).scalar()
                ds = DatasetRef(
                    name=t, kind="table", format="table", locator={"table": t, "schema": schema},
                    row_count=int(count or 0), column_count=len(cols),
                    columns=[{"name": c["name"], "type": str(c["type"]), "primary_key": c["name"] in pk} for c in cols],
                    modified_at=datetime.now(timezone.utc).isoformat(),
                )
                ds.incremental_field = self.detect_incremental(ds)
                ds.cdc_capable = self.detect_cdc(ds)
                ds.locator["foreign_keys"] = [{"columns": fk["constrained_columns"], "references": fk["referred_table"],
                                               "ref_columns": fk["referred_columns"]} for fk in fks]
                out.append(ds)
        return out

    def read(self, dataset: DatasetRef, limit: int | None = None) -> pl.DataFrame:
        from sqlalchemy import select, table, column
        from sqlalchemy import inspect

        eng = self._engine()
        t = dataset.locator["table"]
        schema = dataset.locator.get("schema")
        cols = [c["name"] for c in inspect(eng).get_columns(t, schema=schema)]
        stmt = select(*[column(c) for c in cols]).select_from(table(t, schema=schema))
        if limit:
            stmt = stmt.limit(limit)
        with eng.connect() as con:
            rows = con.execute(stmt).fetchall()
        data = {c: [None if r[i] is None else str(r[i]) for r in rows] for i, c in enumerate(cols)}
        return pl.DataFrame(data, schema={c: pl.Utf8 for c in cols})

    def detect_cdc(self, dataset: DatasetRef) -> bool:
        # SQL Server CDC / change tracking, PostgreSQL logical replication, Oracle LogMiner, MySQL binlog
        return bool(self.spec.supports_cdc)

    def read_metadata(self) -> dict[str, Any]:
        return {"engine": _DB_DIALECTS[self.dialect][2], "demo": self.is_demo()}


def _make_db_connector(cid: str, name: str, color: str, cdc: bool, desc: str, category: str = "database"):
    return type(f"{name.replace(' ', '').replace('(', '').replace(')', '')}Connector", (DatabaseConnector,),
                {"dialect": cid, "spec": _db_spec(cid, name, color, cdc, desc, category)})


SqlServerConnector = _make_db_connector("sqlserver", "SQL Server", "#cc2927", True, "Microsoft SQL Server and Azure SQL. Supports CDC.")
PostgresConnector = _make_db_connector("postgresql", "PostgreSQL", "#336791", True, "PostgreSQL, Aurora and Azure Database for PostgreSQL.")
MySqlConnector = _make_db_connector("mysql", "MySQL", "#00758f", True, "MySQL and MariaDB.")
OracleConnector = _make_db_connector("oracle", "Oracle", "#f80000", True, "Oracle Database. Supports CDC via LogMiner.")
JdbcConnector = _make_db_connector("jdbc", "Other JDBC database", "#64748b", False, "Any JDBC-compatible database via a connection URL.")
JdbcConnector.spec.config_fields.insert(0, FieldSpec(name="connection_url", label="Connection URL", placeholder="dialect+driver://host:port/db"))
AzureSqlConnector = _make_db_connector("azure_sql", "Azure SQL Database", "#0078d4", True, "Azure SQL Database and Managed Instance. Supports CDC.")
MariaDbConnector = _make_db_connector("mariadb", "MariaDB", "#003545", True, "MariaDB Server and SkySQL (binlog CDC).")
Db2Connector = _make_db_connector("db2", "IBM Db2", "#054ada", True, "Db2 for LUW and Db2 for z/OS.")
TeradataConnector = _make_db_connector("teradata", "Teradata", "#f37440", False, "Teradata Vantage tables and views.")
SapHanaConnector = _make_db_connector("sap_hana", "SAP HANA", "#0070f2", True, "SAP HANA and HANA Cloud tables and calculation views.")
SybaseConnector = _make_db_connector("sybase", "SAP ASE (Sybase)", "#1e6bb8", False, "SAP Adaptive Server Enterprise.")
CockroachConnector = _make_db_connector("cockroachdb", "CockroachDB", "#6933ff", True, "CockroachDB (changefeed CDC).")
RedshiftConnector = _make_db_connector("redshift", "Amazon Redshift", "#8c4fff", False, "Redshift provisioned clusters and Serverless.", "warehouse")
SynapseConnector = _make_db_connector("synapse", "Azure Synapse Analytics", "#0078d4", False, "Synapse dedicated and serverless SQL pools.", "warehouse")


# ============================================================================ REST / GraphQL
def _demo_recalls(page: int, page_size: int) -> dict:
    rng = random.Random(7)
    items = []
    for i in range(137):
        d = date(2023, 1, 1) + timedelta(days=rng.randint(0, 700))
        items.append({
            "recall_id": f"RC-{24000 + i}", "manufacturer": rng.choice(["Toyota", "Ford", "Tesla", "BMW", "Volkswagen"]),
            "component": rng.choice(["Airbags", "Brakes", "Software", "Fuel System", "Steering", "Electrical"]),
            "severity": rng.choice(["High", "Medium", "Low", "high"]), "announced": d.isoformat() if rng.random() > 0.2 else d.strftime("%m/%d/%Y"),
            "affected_units": rng.randint(50, 250000), "remedy": {"type": rng.choice(["OTA update", "Dealer repair", "Replacement"]), "free": rng.random() > 0.1},
            "updated_at": (datetime(2025, 6, 1) + timedelta(hours=i)).isoformat(),
        })
    start = (page - 1) * page_size
    return {"data": items[start:start + page_size], "page": page, "total": len(items), "has_more": start + page_size < len(items)}


def _dig(obj: Any, path: str | None) -> Any:
    if not path:
        if isinstance(obj, dict):
            for key in ("data", "results", "items", "records", "value"):
                if isinstance(obj.get(key), list):
                    return obj[key]
        return obj
    for part in path.split("."):
        obj = obj.get(part) if isinstance(obj, dict) else None
    return obj


class RestApiConnector(Connector):
    spec = ConnectorSpec(
        id="rest_api", name="REST API", category="api", icon="globe", color="#0ea5e9",
        description="Any JSON/XML/CSV REST endpoint — no code. Pagination, auth and incremental loads built in.",
        roles=["source", "target"], target_modes=["append"],
        target_note="Sends curated records to the endpoint (POST, batched JSON) — e.g. a webhook or an internal API.",
        auth_methods=[
            AuthMethod(id="none", label="No authentication"),
            AuthMethod(id="api_key", label="API key", fields=[
                FieldSpec(name="api_key_header", label="Header name", default="X-API-Key"),
                FieldSpec(name="api_key", label="API key", type="password", secret=True, required=True)]),
            AuthMethod(id="bearer", label="Bearer token", fields=[FieldSpec(name="token", label="Token", type="password", secret=True, required=True)]),
            AuthMethod(id="basic", label="Username & password", fields=[
                FieldSpec(name="username", label="Username", required=True),
                FieldSpec(name="password", label="Password", type="password", secret=True, required=True)]),
            AuthMethod(id="oauth2", label="OAuth 2.0 (client credentials)", fields=[
                FieldSpec(name="token_url", label="Token URL", type="url", required=True),
                FieldSpec(name="client_id", label="Client ID", required=True),
                FieldSpec(name="client_secret", label="Client secret", type="password", secret=True, required=True),
                FieldSpec(name="scope", label="Scope")]),
        ],
        config_fields=[
            FieldSpec(name="url", label="API URL", type="url", required=True, placeholder="https://api.example.com/v1/items",
                      help="Tip: use demo://recalls to try the built-in vehicle recall API."),
            FieldSpec(name="method", label="HTTP method", type="select", default="GET", options=[{"value": "GET", "label": "GET"}, {"value": "POST", "label": "POST"}]),
            FieldSpec(name="headers", label="Headers", type="keyvalue", advanced=True),
            FieldSpec(name="params", label="Query parameters", type="keyvalue", advanced=True),
            FieldSpec(name="pagination", label="Pagination", type="select", default="none", options=[
                {"value": "none", "label": "None"}, {"value": "page", "label": "Page number"},
                {"value": "offset", "label": "Offset / limit"}, {"value": "cursor", "label": "Cursor / next token"},
                {"value": "link", "label": "Next link in response"}]),
            FieldSpec(name="page_size", label="Page size", type="number", default=50, advanced=True),
            FieldSpec(name="response_format", label="Response format", type="select", default="json", options=[
                {"value": "json", "label": "JSON"}, {"value": "xml", "label": "XML"}, {"value": "csv", "label": "CSV"}]),
            FieldSpec(name="records_path", label="Records location", placeholder="data.items", help="Where the list of records lives in the response. Leave blank to detect automatically.", advanced=True),
            FieldSpec(name="incremental_field", label="Incremental field", placeholder="updated_at"),
        ],
        recommended_ingestion="rest_api", object_label="endpoints", demo_hint="demo://recalls",
    )

    MAX_PAGES = 200

    def _headers(self) -> dict:
        h = {str(k): str(v) for k, v in (self.config.get("headers") or {}).items()}
        auth = self.config.get("auth_method", "none")
        if auth == "api_key":
            h[self.config.get("api_key_header") or "X-API-Key"] = self.secrets.get("api_key", "")
        elif auth == "bearer":
            h["Authorization"] = f"Bearer {self.secrets.get('token', '')}"
        elif auth == "oauth2":
            h["Authorization"] = f"Bearer {self._oauth_token()}"
        return h

    def _oauth_token(self) -> str:
        import httpx

        r = httpx.post(self.config["token_url"], data={"grant_type": "client_credentials", "client_id": self.config.get("client_id"),
                                                        "client_secret": self.secrets.get("client_secret"), "scope": self.config.get("scope")}, timeout=20)
        r.raise_for_status()
        return r.json()["access_token"]

    def _fetch_pages(self, max_records: int | None = None) -> list[dict]:
        url: str = self.config.get("url", "")
        pagination = self.config.get("pagination", "none")
        page_size = int(self.config.get("page_size") or 50)
        records: list[dict] = []
        if url.startswith("demo://"):
            page = 1
            while True:
                body = _demo_recalls(page, page_size)
                records += body["data"]
                if pagination == "none" or not body["has_more"] or (max_records and len(records) >= max_records):
                    break
                page += 1
            return records

        import httpx

        auth = (self.config.get("username") or self.secrets.get("username"), self.secrets.get("password")) if self.config.get("auth_method") == "basic" else None
        params = dict(self.config.get("params") or {})
        page, offset, cursor, next_url = 1, 0, None, url
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            for _ in range(self.MAX_PAGES):
                p = dict(params)
                if pagination == "page":
                    p.update({"page": page, "per_page": page_size})
                elif pagination == "offset":
                    p.update({"offset": offset, "limit": page_size})
                elif pagination == "cursor" and cursor:
                    p["cursor"] = cursor
                resp = client.request(self.config.get("method", "GET"), next_url, headers=self._headers(), params=p, auth=auth)
                resp.raise_for_status()
                fmt = self.config.get("response_format", "json")
                if fmt == "csv":
                    return pl.read_csv(resp.content, infer_schema=False).to_dicts()
                if fmt == "xml":
                    from .files import _xml_records

                    return _xml_records(resp.content)[1]
                body = resp.json()
                batch = _dig(body, self.config.get("records_path"))
                batch = batch if isinstance(batch, list) else [batch]
                records += batch
                if pagination == "none" or not batch or (max_records and len(records) >= max_records):
                    break
                page, offset = page + 1, offset + page_size
                if pagination == "cursor":
                    cursor = body.get("next_cursor") or body.get("cursor") or (body.get("meta") or {}).get("next_cursor")
                    if not cursor:
                        break
                if pagination == "link":
                    next_url = body.get("next") or (body.get("links") or {}).get("next")
                    if not next_url:
                        break
                if pagination in ("page", "offset") and len(batch) < page_size:
                    break
        return records

    def test_connection(self) -> TestResult:
        try:
            recs = self._fetch_pages(max_records=5)
            host = self.config.get("url", "").split("/")[2] if "://" in self.config.get("url", "") else self.config.get("url")
            return TestResult(ok=True, title="Connection successful", message="The API responded with data.", info={
                "Endpoint": host if not self.config.get("url", "").startswith("demo://") else "Demo vehicle recall API",
                "Sample records": len(recs), "Fields detected": len(recs[0]) if recs and isinstance(recs[0], dict) else 0,
                "Format": self.config.get("response_format", "json").upper()})
        except Exception as e:  # noqa: BLE001
            from ..core.errors import friendly_from_exception

            f = friendly_from_exception(e, context="We couldn't reach the API")
            return TestResult(ok=False, title="Connection failed", message=f.message + " Check the URL and authentication settings.", technical=f.technical)

    def discover(self) -> list[DatasetRef]:
        recs = self._fetch_pages()
        url = self.config.get("url", "")
        name = url.rstrip("/").split("/")[-1] or "api_records"
        df = records_to_frame(recs[:500])
        ds = DatasetRef(name=name, kind="endpoint", format=self.config.get("response_format", "json"), locator={"url": url},
                        row_count=len(recs), column_count=df.width, columns=[{"name": c} for c in df.columns])
        ds.incremental_field = self.config.get("incremental_field") or self.detect_incremental(ds)
        return [ds]

    def read(self, dataset: DatasetRef, limit: int | None = None) -> pl.DataFrame:
        recs = self._fetch_pages(max_records=limit)
        return records_to_frame(recs[:limit] if limit else recs)


class GraphQLConnector(RestApiConnector):
    spec = ConnectorSpec(
        id="graphql", name="GraphQL", category="api", icon="share2", color="#e535ab",
        description="Query any GraphQL API with a visual field picker.",
        auth_methods=RestApiConnector.spec.auth_methods,
        config_fields=[FieldSpec(name="url", label="GraphQL endpoint", type="url", required=True),
                       FieldSpec(name="query", label="Query (generated from the field picker)", type="textarea", advanced=True),
                       FieldSpec(name="records_path", label="Records location", placeholder="data.items")],
        recommended_ingestion="rest_api", object_label="queries", availability="preview",
    )

    def _fetch_pages(self, max_records: int | None = None) -> list[dict]:
        import httpx

        r = httpx.post(self.config["url"], json={"query": self.config.get("query", "")}, headers=self._headers(), timeout=30)
        r.raise_for_status()
        recs = _dig(r.json(), self.config.get("records_path") or "data")
        if isinstance(recs, dict):
            recs = next((v for v in recs.values() if isinstance(v, list)), [recs])
        return recs or []


# ============================================================================ SaaS applications
_SAAS_OBJECTS: dict[str, list[tuple[str, list[str], int]]] = {
    "salesforce": [("Account", ["Id", "Name", "Industry", "BillingCountry", "AnnualRevenue", "OwnerId", "LastModifiedDate"], 1240),
                   ("Contact", ["Id", "AccountId", "FirstName", "LastName", "Email", "Phone", "MailingCountry", "LastModifiedDate"], 5210),
                   ("Opportunity", ["Id", "AccountId", "Name", "StageName", "Amount", "CloseDate", "Probability", "LastModifiedDate"], 3180),
                   ("Lead", ["Id", "FirstName", "LastName", "Company", "Email", "Status", "LeadSource", "LastModifiedDate"], 2890),
                   ("Case", ["Id", "AccountId", "Subject", "Status", "Priority", "Origin", "LastModifiedDate"], 4100),
                   ("Campaign", ["Id", "Name", "Type", "Status", "StartDate", "BudgetedCost", "LastModifiedDate"], 86),
                   ("Product2", ["Id", "Name", "ProductCode", "Family", "IsActive", "LastModifiedDate"], 312)],
    "sap": [("KNA1 (Customer master)", ["KUNNR", "NAME1", "LAND1", "ORT01", "PSTLZ", "ERDAT"], 1800),
            ("VBAK (Sales orders)", ["VBELN", "KUNNR", "AUDAT", "NETWR", "WAERK", "AEDAT"], 6400),
            ("MARA (Materials)", ["MATNR", "MTART", "MATKL", "MEINS", "LAEDA"], 950)],
    "servicenow": [("incident", ["sys_id", "number", "short_description", "priority", "state", "assigned_to", "opened_at", "sys_updated_on"], 7300),
                   ("change_request", ["sys_id", "number", "type", "risk", "state", "start_date", "sys_updated_on"], 1150),
                   ("cmdb_ci", ["sys_id", "name", "category", "operational_status", "sys_updated_on"], 2600)],
    "workday": [("Workers", ["Worker_ID", "Legal_Name", "Email", "Hire_Date", "Job_Profile", "Location", "Last_Updated"], 1420),
                ("Positions", ["Position_ID", "Job_Profile", "Supervisory_Org", "Is_Filled", "Last_Updated"], 1600),
                ("Organizations", ["Org_ID", "Name", "Type", "Manager_ID", "Last_Updated"], 140)],
    "snowflake": [("SALES.PUBLIC.CUSTOMERS", ["CUSTOMER_ID", "NAME", "EMAIL", "COUNTRY", "CREATED_AT", "UPDATED_AT"], 25000),
                  ("SALES.PUBLIC.ORDERS", ["ORDER_ID", "CUSTOMER_ID", "ORDER_TS", "AMOUNT", "STATUS", "UPDATED_AT"], 180000)],
    "hubspot": [("contacts", ["id", "email", "firstname", "lastname", "lifecyclestage", "hs_lastmodifieddate"], 8800),
                ("deals", ["id", "dealname", "amount", "dealstage", "closedate", "hs_lastmodifieddate"], 2100)],
}

_SAAS_META = {
    "salesforce": ("Salesforce", "#00a1e0", "cloud", "CRM objects: accounts, contacts, opportunities, cases.", "lakeflow_connect", True),
    "sap": ("SAP", "#0070f2", "boxes", "SAP ECC / S/4HANA tables and CDS views.", "lakeflow_connect", True),
    "servicenow": ("ServiceNow", "#62d84e", "life-buoy", "ITSM incidents, changes and CMDB.", "lakeflow_connect", True),
    "workday": ("Workday", "#f5a623", "users", "HR workers, positions and organizations (RaaS).", "lakeflow_connect", False),
    "snowflake": ("Snowflake", "#29b5e8", "snowflake", "Tables and views from Snowflake (Lakehouse Federation).", "jdbc", True),
    "hubspot": ("HubSpot", "#ff7a59", "megaphone", "Marketing contacts and deals.", "rest_api", False),
}


def _saas_value(col: str, i: int, rng: random.Random) -> str | None:
    lc = col.lower()
    if rng.random() < 0.03 and not lc.endswith("id") and lc not in ("id", "sys_id", "number"):
        return None
    if lc in ("id", "sys_id") or lc.endswith("_id") or lc.endswith("id") or lc in ("kunnr", "vbeln", "matnr", "number"):
        return f"{col[:3].upper()}{100000 + i}"
    if "email" in lc:
        return f"user{i}@example.com" if rng.random() > 0.04 else f"user{i}example.com"
    if "phone" in lc:
        return rng.choice([f"(555) {rng.randint(200, 999)}-{rng.randint(1000, 9999)}", f"+1 555 {rng.randint(200, 999)} {rng.randint(1000, 9999)}"])
    if any(k in lc for k in ("date", "modified", "updated", "_at", "_on", "erdat", "audat", "aedat", "laeda", "ts")):
        return (datetime(2024, 1, 1) + timedelta(hours=rng.randint(0, 13000))).isoformat()
    if any(k in lc for k in ("amount", "revenue", "cost", "netwr", "probability")):
        return f"{rng.uniform(100, 250000):.2f}"
    if "country" in lc or lc == "land1":
        return rng.choice(["US", "USA", "United States", "DE", "GB", "Canada"])
    if "firstname" in lc or lc == "first_name":
        return rng.choice(_FIRST)
    if "lastname" in lc or lc == "last_name":
        return rng.choice(_LAST)
    if lc in ("name", "name1", "legal_name", "company", "dealname") or lc.endswith("name"):
        return f"{rng.choice(_LAST)} {rng.choice(['Holdings', 'Motors', 'Logistics', 'Group', 'Partners', 'Fleet Services'])}"
    if lc in ("status", "stagename", "state", "dealstage", "lifecyclestage"):
        return rng.choice(["Open", "Closed Won", "In Progress", "closed", "New", "Qualified"])
    if lc in ("priority", "risk", "severity"):
        return rng.choice(["1 - Critical", "2 - High", "3 - Moderate", "4 - Low"])
    if lc in ("isactive", "is_filled"):
        return rng.choice(["true", "false"])
    return rng.choice(["Alpha", "Beta", "Gamma", "Delta", "Omega", "North", "South"]) + f" {i % 50}"


class SaaSConnector(Connector):
    """Application connectors. Real deployments ingest these through Databricks Lakeflow Connect managed
    connectors; EasyETL discovers objects and schemas via each app's metadata API. When credentials are
    not provided (or the sandbox environment is chosen) a realistic sandbox org is used."""

    app = "salesforce"

    # Subclasses declared as data (see connectors/catalog.py) override these.
    objects: list[tuple[str, list[str], int]] | None = None
    instance: str | None = None
    api_version: str | None = None
    object_kind = "object"
    sandbox_keys: tuple[str, ...] = ("environment",)

    def _objects(self) -> list[tuple[str, list[str], int]]:
        return self.objects or _SAAS_OBJECTS[self.app]

    def _sandbox(self) -> bool:
        if self.config.get("environment") == "sandbox":
            return True
        if any(str(self.config.get(k) or "").strip().lower() in ("demo", "sandbox") for k in self.sandbox_keys if k != "environment"):
            return True
        return not self.secrets

    def test_connection(self) -> TestResult:
        name = self.spec.name
        if not self._sandbox():
            if self.app == "salesforce" and self.config.get("auth_method") == "password" and not self.secrets.get("password"):
                return TestResult(ok=False, title="Connection failed", message="Please provide the password and security token.")
            # Live validation of application credentials runs on Databricks (Lakeflow Connect / Spark connector) at deploy time;
            # this server doesn't call third-party APIs directly, so say exactly that instead of claiming a live connection.
            return TestResult(ok=True, title="Credentials saved", message=(
                f"{name} credentials are stored encrypted. They're validated on Databricks when the pipeline is deployed. "
                "Until then EasyETL shows the standard object catalog with sample rows so you can design the pipeline."), info={
                "Organization": self.config.get("organization") or self.config.get("host") or "—", "Validation": "At deploy time",
                "Objects shown": f"{len(self._objects())} (standard catalog)", "Environment": "Production"})
        info = {
            "Organization": self.config.get("organization") or "Northwind Motors",
            "Instance": self.instance or {"salesforce": "na213.my.salesforce.com", "sap": "S/4HANA 2023 · client 100", "servicenow": "northwind.service-now.com",
                                          "workday": "wd5-impl-services1.workday.com", "snowflake": "nw12345.eu-west-1", "hubspot": "Portal 44821"}.get(self.app, "sandbox"),
            "API version": self.api_version or {"salesforce": "v61.0", "sap": "OData V4", "servicenow": "Table API", "workday": "RaaS v42.2", "snowflake": "SQL API",
                                                "hubspot": "CRM v3"}.get(self.app, "—"),
            f"Available {self.spec.object_label}": len(self._objects()),
            "Environment": "Sandbox (sample data)",
        }
        return TestResult(ok=True, title="Connection successful", message=f"Connected to the {name} sandbox.", info=info)

    def discover(self) -> list[DatasetRef]:
        out = []
        for i, (obj, cols, rows) in enumerate(self._objects()):
            ds = DatasetRef(name=obj, kind=self.object_kind, format="api", locator={"object": obj}, row_count=rows, column_count=len(cols),
                            columns=[{"name": c} for c in cols], selected=i < 3,
                            modified_at=(datetime.now(timezone.utc) - timedelta(hours=i * 7)).isoformat())
            ds.incremental_field = self.detect_incremental(ds)
            ds.cdc_capable = self.spec.supports_cdc
            out.append(ds)
        return out

    def read(self, dataset: DatasetRef, limit: int | None = None) -> pl.DataFrame:
        obj = dataset.locator["object"]
        cols, rows = next((c, r) for o, c, r in self._objects() if o == obj)
        n = min(rows, limit or rows)
        rng = random.Random(zlib.crc32(obj.encode()))
        data = {c: [_saas_value(c, i, rng) for i in range(n)] for c in cols}
        return pl.DataFrame(data, schema={c: pl.Utf8 for c in cols})


def _make_saas(app: str):
    name, color, icon, desc, ingestion, cdc = _SAAS_META[app]
    auth = [AuthMethod(id="oauth", label="OAuth (recommended)", fields=[]),
            AuthMethod(id="password", label="Username & password", fields=[
                FieldSpec(name="username", label="Username", required=True),
                FieldSpec(name="password", label="Password", type="password", secret=True, required=True),
                *([FieldSpec(name="security_token", label="Security token", type="password", secret=True)] if app == "salesforce" else [])]),
            AuthMethod(id="token", label="API token", fields=[FieldSpec(name="api_token", label="API token", type="password", secret=True, required=True)])]
    reverse_etl = app == "salesforce"
    spec = ConnectorSpec(
        id=app, name=name, category="warehouse" if app == "snowflake" else "application", icon=icon, color=color, description=desc, auth_methods=auth,
        roles=["source", "target"] if reverse_etl or app == "snowflake" else ["source"],
        target_modes=["append", "overwrite", "merge"] if app == "snowflake" else (["append", "merge"] if reverse_etl else []),
        target_note="Writes tables with the Snowflake Spark connector." if app == "snowflake" else (
            f"Reverse ETL: upserts curated records into {name} objects with the Bulk API 2.0 (external ID field)." if reverse_etl else None),
        config_fields=[FieldSpec(name="environment", label="Environment", type="select", default="production",
                                 options=[{"value": "production", "label": "Production"}, {"value": "sandbox", "label": "Sandbox"}]),
                       FieldSpec(name="organization", label="Organization / instance", placeholder="mycompany")],
        supports_cdc=cdc, recommended_ingestion=ingestion, availability="ga" if app in ("salesforce", "servicenow", "workday", "sap") else "preview",
        object_label="objects",
    )
    return type(f"{name}Connector", (SaaSConnector,), {"app": app, "spec": spec})


SalesforceConnector = _make_saas("salesforce")
SapConnector = _make_saas("sap")
ServiceNowConnector = _make_saas("servicenow")
WorkdayConnector = _make_saas("workday")
SnowflakeConnector = _make_saas("snowflake")
HubSpotConnector = _make_saas("hubspot")


# ============================================================================ Cloud storage / SFTP
class CloudStorageConnector(Connector):
    provider = "s3"

    def _is_demo(self) -> bool:
        return (self.config.get("bucket") or "").lower() in ("demo", "easyetl-demo", "")

    def _list(self) -> list[tuple[str, Path]]:
        if self._is_demo():
            return [(p.name, p) for p in sorted(DEMO_DIR.iterdir()) if p.suffix in (".csv", ".json", ".xml", ".xlsx", ".zip")]
        if self.provider == "sftp":
            raise RuntimeError("SFTP access requires the paramiko adapter (enable 'sftp' extra).")
        raise RuntimeError(f"{self.spec.name} access requires the cloud SDK adapter to be enabled for this workspace.")

    def test_connection(self) -> TestResult:
        try:
            files = self._list()
            return TestResult(ok=True, title="Connection successful", message=f"Connected to {self.spec.name}.", info={
                "Location": "easyetl-demo (sample bucket)" if self._is_demo() else self.config.get("bucket"),
                "Files found": len(files), "Access": "Read only"})
        except Exception as e:  # noqa: BLE001
            return TestResult(ok=False, title="Connection failed", message=f"We couldn't list files in {self.spec.name}. Check the location and credentials.", technical=str(e))

    def discover(self) -> list[DatasetRef]:
        out = []
        for name, path in self._list():
            det = detect_file(path, name)
            for e in det["entries"]:
                if not e.get("supported", True) or not e.get("row_count"):
                    continue
                out.append(DatasetRef(name=f"{Path(name).stem}" + (f" › {e['name']}" if len(det['entries']) > 1 else ""), kind="file",
                                      format=e["format"], locator={"path": name, **e["locator"]}, row_count=e["row_count"],
                                      column_count=e["column_count"], columns=[{"name": c} for c in e["columns"]],
                                      size_bytes=det["size_bytes"], selected=False,
                                      modified_at=datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()))
        return out

    def read(self, dataset: DatasetRef, limit: int | None = None) -> pl.DataFrame:
        loc = dict(dataset.locator)
        name = loc.pop("path")
        path = dict(self._list())[name]
        return read_file_entry(path, name, loc, limit)

    def detect_cdc(self, dataset: DatasetRef) -> bool:
        return False


def _make_cloud(provider: str, name: str, color: str, fields: list[FieldSpec], desc: str, auth: list[AuthMethod]):
    spec = ConnectorSpec(id=provider, name=name, category="cloud_storage", icon="hard-drive" if provider != "sftp" else "server",
                         color=color, description=desc, config_fields=fields, auth_methods=auth,
                         roles=["source", "target"], target_modes=["append", "overwrite"],
                         target_note="Exports Parquet, Delta, CSV or JSON files to this location.",
                         recommended_ingestion="auto_loader", object_label="files", demo_hint="easyetl-demo")
    return type(f"{name.replace(' ', '')}Connector", (CloudStorageConnector,), {"provider": provider, "spec": spec})


_loc_help = "Tip: enter 'easyetl-demo' to browse the sample bucket."
S3Connector = _make_cloud("s3", "Amazon S3", "#ff9900", [
    FieldSpec(name="bucket", label="Bucket", required=True, placeholder="my-landing-bucket", help=_loc_help),
    FieldSpec(name="prefix", label="Folder / prefix", placeholder="exports/crm/"), FieldSpec(name="region", label="Region", default="us-east-1", advanced=True)],
    "Files landing in Amazon S3.", [AuthMethod(id="iam_role", label="IAM role (recommended)"), AuthMethod(id="keys", label="Access keys", fields=[
        FieldSpec(name="access_key_id", label="Access key ID", required=True), FieldSpec(name="secret_access_key", label="Secret access key", type="password", secret=True, required=True)])])
AdlsConnector = _make_cloud("adls", "Azure Data Lake Storage", "#0078d4", [
    FieldSpec(name="account", label="Storage account", required=True), FieldSpec(name="bucket", label="Container", required=True, help=_loc_help),
    FieldSpec(name="prefix", label="Folder")], "ADLS Gen2 containers.", [AuthMethod(id="managed_identity", label="Managed identity (recommended)"),
    AuthMethod(id="sas", label="SAS token", fields=[FieldSpec(name="sas_token", label="SAS token", type="password", secret=True, required=True)])])
BlobConnector = _make_cloud("azure_blob", "Azure Blob Storage", "#2f7bd3", [
    FieldSpec(name="account", label="Storage account", required=True), FieldSpec(name="bucket", label="Container", required=True, help=_loc_help)],
    "Azure Blob containers.", [AuthMethod(id="managed_identity", label="Managed identity"), AuthMethod(id="key", label="Account key", fields=[
        FieldSpec(name="account_key", label="Account key", type="password", secret=True, required=True)])])
GcsConnector = _make_cloud("gcs", "Google Cloud Storage", "#4285f4", [
    FieldSpec(name="bucket", label="Bucket", required=True, help=_loc_help), FieldSpec(name="prefix", label="Folder")],
    "GCS buckets.", [AuthMethod(id="service_account", label="Service account", fields=[
        FieldSpec(name="service_account_json", label="Service account key (JSON)", type="password", secret=True, required=True)])])
SftpConnector = _make_cloud("sftp", "SFTP", "#475569", [
    FieldSpec(name="host", label="Host", required=True), FieldSpec(name="port", label="Port", type="number", default=22),
    FieldSpec(name="bucket", label="Remote folder", required=True, help=_loc_help)],
    "Files on an SFTP server.", [AuthMethod(id="password", label="Username & password", fields=[
        FieldSpec(name="username", label="Username", required=True), FieldSpec(name="password", label="Password", type="password", secret=True, required=True)]),
        AuthMethod(id="key", label="SSH key", fields=[FieldSpec(name="private_key", label="Private key", type="password", secret=True, required=True)])])
SftpConnector.spec.roles, SftpConnector.spec.target_modes, SftpConnector.spec.target_note = ["source"], [], None

# Snowflake needs warehouse coordinates (not just an org name) to read and to be a write target.
SnowflakeConnector.spec.config_fields = [
    FieldSpec(name="account", label="Account identifier", required=True, placeholder="myorg-myaccount", help="Tip: enter 'demo' for sample tables."),
    FieldSpec(name="warehouse", label="Warehouse", placeholder="COMPUTE_WH"), FieldSpec(name="database", label="Database", placeholder="ANALYTICS"),
    FieldSpec(name="schema", label="Schema", default="PUBLIC"), FieldSpec(name="role", label="Role", advanced=True)]
SnowflakeConnector.spec.auth_methods = [
    AuthMethod(id="password", label="Username & password", fields=[FieldSpec(name="username", label="Username", required=True),
                                                                   FieldSpec(name="password", label="Password", type="password", secret=True, required=True)]),
    AuthMethod(id="key_pair", label="Key pair (recommended)", fields=[FieldSpec(name="username", label="Username", required=True),
                                                                      FieldSpec(name="private_key", label="Private key (PEM)", type="password", secret=True, required=True)]),
    AuthMethod(id="oauth", label="OAuth")]
SnowflakeConnector.sandbox_keys = ("environment", "account")
SalesforceConnector.spec.auth_methods[2].label = "OAuth access token"
