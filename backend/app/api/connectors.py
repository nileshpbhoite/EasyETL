from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..connectors.registry import get_connector_class, list_specs
from ..core.errors import FriendlyError
from ..core.models import Connection
from ..core.security import SecretStore, audit
from .common import DB, ConnManager, User, iso

router = APIRouter(prefix="/api", tags=["connectors"])

CATEGORY_LABELS = {"file": "Files", "application": "Applications", "database": "Databases", "cloud_storage": "Cloud Storage", "api": "APIs"}


@router.get("/connectors")
def connectors(user: User):
    specs = [s.model_dump() for s in list_specs()]
    return {"categories": [{"id": k, "label": v, "connectors": [s for s in specs if s["category"] == k]} for k, v in CATEGORY_LABELS.items()]}


class ConnectionIn(BaseModel):
    connector: str
    name: str | None = None
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


@router.post("/connections")
def save_connection(body: ConnectionIn, user: ConnManager, db: DB):
    cls = get_connector_class(body.connector)
    config, secrets = split_secrets(body.connector, {**body.config, "auth_method": body.auth_method}, body.secrets)
    result = cls(config, secrets).test_connection()
    ref = SecretStore(db, user.tenant_id).put(secrets)
    conn = Connection(tenant_id=user.tenant_id, name=body.name or f"{cls.spec.name} connection", connector=body.connector, config=config,
                      secret_ref=ref, status="connected" if result.ok else "failed", info=result.info)
    db.add(conn)
    audit(db, user, "connection.create", body.connector, name=conn.name)
    db.commit()
    return {"id": conn.id, "name": conn.name, "connector": conn.connector, "status": conn.status, "info": conn.info, "test": result.model_dump()}


@router.get("/connections")
def list_connections(user: User, db: DB):
    rows = db.scalars(select(Connection).where(Connection.tenant_id == user.tenant_id).order_by(Connection.created_at.desc())).all()
    return [{"id": c.id, "name": c.name, "connector": c.connector, "status": c.status, "info": c.info, "config": c.config,
             "has_secrets": bool(c.secret_ref), "created_at": iso(c.created_at)} for c in rows]


@router.delete("/connections/{conn_id}")
def delete_connection(conn_id: str, user: ConnManager, db: DB):
    c = db.get(Connection, conn_id)
    if not c or c.tenant_id != user.tenant_id:
        raise FriendlyError("Not found", "Connection not found.", status_code=404)
    db.delete(c)
    audit(db, user, "connection.delete", conn_id)
    db.commit()
    return {"ok": True}
