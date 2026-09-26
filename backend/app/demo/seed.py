"""Seeds a demo tenant, users, built-in templates and realistic demo pipelines (so the product can be shown without
connecting a real system). Runs once on an empty database."""
from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.models import FileAsset, Pipeline, Template, Tenant, User
from ..core.security import CurrentUser, hash_password
from ..core.storage import get_storage, new_key

log = logging.getLogger("easyetl.seed")
DEMO_DIR = Path(__file__).parent / "data"
DEMO_PASSWORD = "easyetl-demo"

BUILTIN_TEMPLATES = [
    ("Customer 360", "Customer", "file",
     "Unify customer master data with orders, vehicles and service history into a governed customer_360 Gold model.",
     ["Deduplicate customers (keep most recent)", "Standardize phones, emails & countries", "Customer age & lifetime metrics", "PII masking with Unity Catalog"],
     [{"type": "trim_whitespace", "params": {}}, {"type": "validate_email", "params": {"column": "email", "invalid": "null"}},
      {"type": "standardize_phone", "params": {"column": "phone", "default_country": "US", "invalid": "null"}},
      {"type": "standardize_country", "params": {"column": "country", "output_format": "name"}},
      {"type": "calculate_age", "params": {"column": "date_of_birth", "output": "customer_age"}}]),
    ("Sales Analytics", "Sales", "file", "Clean order transactions and publish daily sales summaries by product, channel and region.",
     ["Parse mixed date formats", "Currency amounts to numbers", "Status standardization", "Daily sales Gold table"],
     [{"type": "remove_duplicates", "params": {"columns": [], "keep": "first"}}, {"type": "parse_date", "params": {"columns": ["order_date"]}},
      {"type": "standardize_values", "params": {"column": "status", "case": "title"}}]),
    ("Finance Data", "Finance", "database", "Ledger and invoice data with strict validation, currency conversion and audit-ready lineage.",
     ["Strict referential integrity", "Currency conversion to USD", "Negative amount checks", "Full audit trail"],
     [{"type": "trim_whitespace", "params": {}}]),
    ("Marketing Data", "Marketing", "application", "Campaign, lead and contact data prepared for segmentation and attribution.",
     ["Email hygiene", "Lead de-duplication (fuzzy)", "Consent flags standardized", "Segment rules"],
     [{"type": "validate_email", "params": {"column": "email", "invalid": "null"}}]),
    ("SAP Customer Data", "ERP", "application", "SAP KNA1/VBAK extraction via Lakeflow Connect with business-friendly naming.",
     ["Lakeflow Connect CDC", "SAP field names → business names", "Customer master Silver", "Sales order Gold"],
     [{"type": "trim_whitespace", "params": {}}]),
    ("Salesforce CRM", "CRM", "application", "Accounts, contacts and opportunities synced incrementally with pipeline analytics in Gold.",
     ["Incremental sync on LastModifiedDate", "Contact email & phone cleanup", "Account hierarchy", "Opportunity pipeline Gold"],
     [{"type": "validate_email", "params": {"column": "Email", "invalid": "null"}},
      {"type": "standardize_phone", "params": {"column": "Phone", "default_country": "US", "invalid": "null"}}]),
    ("Generic File Modernization", "General", "file", "Turn any spreadsheet or flat file into a governed Bronze → Silver → Gold Lakehouse.",
     ["Auto-detect types", "Trim & standardize text", "Duplicate removal", "Snake_case naming"],
     [{"type": "trim_whitespace", "params": {}}, {"type": "remove_duplicates", "params": {"columns": [], "keep": "first"}}]),
]


def _system_user(tenant_id: str, user_id: str) -> CurrentUser:
    return CurrentUser(id=user_id, tenant_id=tenant_id, email="system@easyetl", name="EasyETL", role="admin")


def seed(db: Session, with_pipelines: bool = True) -> None:
    if db.scalars(select(Tenant)).first():
        return
    tenant = Tenant(name="Northwind Motors")
    db.add(tenant)
    db.flush()
    from ..api.auth import DEMO_USERS

    users = {}
    for role, (email, name) in DEMO_USERS.items():
        u = User(tenant_id=tenant.id, email=email, name=name, role=role, password_hash=hash_password(DEMO_PASSWORD))
        db.add(u)
        users[role] = u
    for name, category, hint, desc, highlights, transforms in BUILTIN_TEMPLATES:
        db.add(Template(tenant_id=None, name=name, description=desc, category=category, source_hint=hint,
                        config={"transformations": transforms, "highlights": highlights,
                                "ingestion": {"mode": "incremental", "schema_evolution": "add_new_columns"},
                                "governance": {"unity_catalog": True, "audit": True, "lineage": True, "column_masks": True}}))
    db.commit()
    if with_pipelines:
        try:
            _seed_pipelines(db, tenant.id, users["admin"].id)
        except Exception:  # noqa: BLE001 - demo content must never block startup
            log.exception("Demo pipeline seeding failed")


def _import(db: Session, tenant_id: str, name: str) -> str:
    from ..connectors.files import detect_file

    key = new_key(f"uploads/{tenant_id}", name)
    with (DEMO_DIR / name).open("rb") as fh:
        size = get_storage().put(key, fh)
    asset = FileAsset(tenant_id=tenant_id, filename=name, storage_key=key, size_bytes=size, detection=detect_file(get_storage().path(key), name))
    db.add(asset)
    db.commit()
    return asset.id


def _build(db: Session, user: CurrentUser, name: str, connector: str, config: dict, *, deploy: bool, frequency: str | None = None,
           select_names: list[str] | None = None) -> Pipeline:
    from ..connectors.registry import get_connector_class
    from ..deploy.deployer import SimulatedDeployer
    from ..engine import service
    from ..engine.runtime import PipelineRuntime
    from ..monitoring import service as monitoring

    row = service.create(db, user, name)
    row, meta = service.load(db, user, row.id)
    spec = get_connector_class(connector).spec
    meta.source.category, meta.source.connector, meta.source.name, meta.source.config = spec.category, connector, spec.name, config
    rt = PipelineRuntime(db, user.tenant_id, meta, row.id)
    conn = rt.connector()
    test = conn.test_connection()
    meta.source.connection_info = {"ok": test.ok, "title": test.title, "message": test.message, "info": test.info}
    meta.source.datasets = conn.discover()
    if select_names is not None:
        for d in meta.source.datasets:
            d.selected = any(s in d.name for s in select_names)
    service.run_analysis(rt)
    service.apply_recommendations(rt, [r.id for r in meta.recommendations if r.preselected])
    if frequency:
        meta.ingestion.frequency = frequency  # type: ignore[assignment]
    meta.mark_complete("transform")
    meta.mark_complete("configure")
    meta.mark_complete("design")
    meta.current_step = "review"
    if deploy:
        rt._transformed.clear()
        hc = service.health_check(rt)
        if hc["ready"]:
            meta.mark_complete("review")
            state = SimulatedDeployer().deploy(row.id, meta, "production")
            state.deployed_version = row.version + 1
            meta.deployment = state
            meta.mark_complete("deploy")
            meta.current_step = "monitor"
    row = service.save(db, user, row, meta, "Demo pipeline prepared")
    if deploy and meta.deployment.status == "deployed":
        row.environment = "production"
        row.status = "running"
        db.commit()
        monitoring.ensure_runs(db, row, meta)
    return row


def _seed_pipelines(db: Session, tenant_id: str, user_id: str) -> None:
    user = _system_user(tenant_id, user_id)
    files = [_import(db, tenant_id, n) for n in ("Customer_Data.xlsx", "Orders.csv", "Vehicles.json", "Service_History.xml")]
    _build(db, user, "Customer 360 — Dealer Network", "file_upload", {"file_ids": files}, deploy=True, frequency="daily",
           select_names=["Customers", "Orders", "Vehicles", "Service_History"])
    _build(db, user, "Salesforce CRM Sync", "salesforce", {"environment": "sandbox", "organization": "Northwind Motors"}, deploy=True, frequency="hourly")
    _build(db, user, "Dealer Inventory (SQL Server)", "sqlserver", {"host": "demo", "database": "dealer_dms"}, deploy=True, frequency="hourly")
    _build(db, user, "Vehicle Recalls API", "rest_api", {"url": "demo://recalls", "pagination": "page", "page_size": 50}, deploy=False)
