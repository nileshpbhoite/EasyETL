from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..connectors.registry import get_connector_class, list_specs
from ..core.errors import FriendlyError
from ..core.models import Connection
from ..core.security import SecretStore, audit
from .common import DB, ConnManager, User, iso

router = APIRouter(prefix="/api", tags=["connectors"])

CATEGORY_LABELS = {"file": "Files", "application": "Applications", "warehouse": "Warehouses & Lakehouses", "database": "Databases",
                   "cloud_storage": "Cloud Storage & Files", "streaming": "Streaming", "nosql": "NoSQL", "api": "APIs"}


@router.get("/connectors")
def connectors(user: User):
    specs = [s.model_dump() for s in list_specs()]
    return {"categories": [{"id": k, "label": v, "connectors": [s for s in specs if s["category"] == k]} for k, v in CATEGORY_LABELS.items()]}


class ConnectionIn(BaseModel):
    connector: str
    name: str | None = None
    usage: Literal["source", "target", "both"] = "source"
    auth_method: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, Any] = Field(default_factory=dict)


def split_secrets(connector: str, config: dict, secrets: dict) -> tuple[dict, dict]:
    """Guarantee secret fields never land in plain configuration, whatever the client sends."""
    spec = get_connector_class(connector).spec
    secret_names = {f.name for m in spec.auth_methods for f in m.fields if f.secret} | {f.name for f in spec.config_fields if f.secret}
    clean = {k: v for k, v in config.items() if k not in secret_names}
    sec = {**{k: v for k, v in config.items() if k in secret_names}, **secrets}
    return clean, sec


@router.post("/connections/test")
def test_connection(body: ConnectionIn, user: ConnManager, db: DB):
    cls = get_connector_class(body.connector)
    config, secrets = split_secrets(body.connector, {**body.config, "auth_method": body.auth_method}, body.secrets)
    result = cls(config, secrets).test_connection()
    audit(db, user, "connection.test", body.connector, ok=result.ok)
    db.commit()
    return result.model_dump()


def check_usage(connector: str, usage: str) -> None:
    spec = get_connector_class(connector).spec
    if usage in ("target", "both") and "target" not in spec.roles:
        raise FriendlyError("Can't be a target", f"{spec.name} can be used as a source only.")
    if usage in ("source", "both") and "source" not in spec.roles:
        raise FriendlyError("Can't be a source", f"{spec.name} can be used as a target only.")


def conn_out(c: Connection) -> dict:
    spec = get_connector_class(c.connector).spec
    return {"id": c.id, "name": c.name, "connector": c.connector, "connector_name": spec.name, "category": spec.category, "usage": c.usage or "source",
            "roles": spec.roles, "target_modes": spec.target_modes, "status": c.status, "info": c.info, "config": c.config,
            "has_secrets": bool(c.secret_ref), "created_at": iso(c.created_at)}


@router.post("/connections")
def save_connection(body: ConnectionIn, user: ConnManager, db: DB):
    check_usage(body.connector, body.usage)
    cls = get_connector_class(body.connector)
    config, secrets = split_secrets(body.connector, {**body.config, "auth_method": body.auth_method}, body.secrets)
    result = cls(config, secrets).test_connection()
    ref = SecretStore(db, user.tenant_id).put(secrets)
    conn = Connection(tenant_id=user.tenant_id, name=body.name or f"{cls.spec.name} connection", connector=body.connector, config=config,
                      usage=body.usage, secret_ref=ref, status="connected" if result.ok else "failed", info=result.info)
    db.add(conn)
    if body.connector == "databricks" and config.get("use_for_deployment"):
        for other in db.scalars(select(Connection).where(Connection.tenant_id == user.tenant_id, Connection.connector == "databricks")).all():
            if (other.config or {}).get("use_for_deployment"):
                other.config = {**other.config, "use_for_deployment": False}
    audit(db, user, "connection.create", body.connector, name=conn.name, usage=body.usage)
    db.commit()
    return {**conn_out(conn), "test": result.model_dump()}


@router.get("/connections")
def list_connections(user: User, db: DB, usage: Literal["source", "target"] | None = None):
    rows = db.scalars(select(Connection).where(Connection.tenant_id == user.tenant_id).order_by(Connection.created_at.desc())).all()
    out = [conn_out(c) for c in rows]
    return [c for c in out if usage is None or c["usage"] in (usage, "both")]


class ConnectionPatch(BaseModel):
    name: str | None = None
    usage: Literal["source", "target", "both"] | None = None
    use_for_deployment: bool | None = None


@router.patch("/connections/{conn_id}")
def patch_connection(conn_id: str, body: ConnectionPatch, user: ConnManager, db: DB):
    c = db.get(Connection, conn_id)
    if not c or c.tenant_id != user.tenant_id:
        raise FriendlyError("Not found", "Connection not found.", status_code=404)
    if body.usage:
        check_usage(c.connector, body.usage)
        c.usage = body.usage
    if body.name:
        c.name = body.name
    if body.use_for_deployment is not None:
        if c.connector != "databricks":
            raise FriendlyError("Not a Databricks connection", "Only Databricks connections can be used for deployments.")
        if body.use_for_deployment:  # only one deployment workspace per tenant
            for other in db.scalars(select(Connection).where(Connection.tenant_id == user.tenant_id, Connection.connector == "databricks")).all():
                if other.id != c.id and (other.config or {}).get("use_for_deployment"):
                    other.config = {**other.config, "use_for_deployment": False}
        c.config = {**(c.config or {}), "use_for_deployment": body.use_for_deployment}
    audit(db, user, "connection.update", conn_id, **body.model_dump(exclude_none=True))
    db.commit()
    return conn_out(c)


@router.delete("/connections/{conn_id}")
def delete_connection(conn_id: str, user: ConnManager, db: DB):
    c = db.get(Connection, conn_id)
    if not c or c.tenant_id != user.tenant_id:
        raise FriendlyError("Not found", "Connection not found.", status_code=404)
    db.delete(c)
    audit(db, user, "connection.delete", conn_id)
    db.commit()
    return {"ok": True}
