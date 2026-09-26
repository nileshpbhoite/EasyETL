"""Authentication (OAuth2 bearer / JWT, SSO-ready), RBAC, secrets encryption and audit logging."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone
from typing import Annotated

from cryptography.fernet import Fernet
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .config import BASE_DIR, get_settings
from .db import get_db
from .models import AuditLog, Secret, User

ROLES = ("admin", "data_engineer", "analyst", "viewer")

# Permission matrix — every API route declares the permission it needs.
PERMISSIONS: dict[str, set[str]] = {
    "admin": {"read", "edit", "deploy", "manage_connections", "admin"},
    "data_engineer": {"read", "edit", "deploy", "manage_connections"},
    "analyst": {"read", "edit"},
    "viewer": {"read"},
}

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token", auto_error=False)


class CurrentUser(BaseModel):
    id: str
    tenant_id: str
    email: str
    name: str
    role: str


# ---------------------------------------------------------------- passwords
def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def verify_password(password: str, stored: str | None) -> bool:
    if not stored or "$" not in stored:
        return False
    salt_b64, _ = stored.split("$", 1)
    return hmac.compare_digest(hash_password(password, base64.b64decode(salt_b64)), stored)


# ---------------------------------------------------------------- tokens
def create_access_token(user: User) -> str:
    s = get_settings()
    payload = {
        "sub": user.id,
        "tid": user.tenant_id,
        "role": user.role,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=s.jwt_expiry_minutes),
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def get_current_user(
    token: Annotated[str | None, Depends(oauth2_scheme)], db: Annotated[Session, Depends(get_db)]
) -> CurrentUser:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Your session has expired. Please sign in again.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise unauthorized
    s = get_settings()
    try:
        payload = jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm])
    except JWTError:
        raise unauthorized
    user = db.get(User, payload.get("sub"))
    if not user:
        raise unauthorized
    return CurrentUser(id=user.id, tenant_id=user.tenant_id, email=user.email, name=user.name, role=user.role)


def require(permission: str):
    """Dependency factory enforcing RBAC."""

    def checker(user: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
        if permission not in PERMISSIONS.get(user.role, set()):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Your role ({user.role.replace('_', ' ')}) doesn't allow this action.",
            )
        return user

    return checker


# ---------------------------------------------------------------- secrets
def _fernet() -> Fernet:
    s = get_settings()
    key = s.secrets_key
    if not key:
        key_file = BASE_DIR / "data" / ".secret_key"
        if not key_file.exists():
            key_file.parent.mkdir(parents=True, exist_ok=True)
            key_file.write_bytes(Fernet.generate_key())
            os.chmod(key_file, 0o600)
        key = key_file.read_text().strip()
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()


class SecretStore:
    """Credentials are encrypted at rest (Fernet/AES-128-CBC+HMAC) and referenced by id.
    Swap for Databricks secret scopes / Azure Key Vault / AWS Secrets Manager in production."""

    def __init__(self, db: Session, tenant_id: str):
        self.db, self.tenant_id = db, tenant_id

    def put(self, payload: dict) -> str | None:
        clean = {k: v for k, v in payload.items() if v not in (None, "")}
        if not clean:
            return None
        import json

        secret = Secret(tenant_id=self.tenant_id, ciphertext=encrypt(json.dumps(clean)))
        self.db.add(secret)
        self.db.flush()
        return secret.id

    def get(self, ref: str | None) -> dict:
        if not ref:
            return {}
        import json

        secret = self.db.get(Secret, ref)
        if not secret or secret.tenant_id != self.tenant_id:
            return {}
        return json.loads(decrypt(secret.ciphertext))


# ---------------------------------------------------------------- audit
def audit(db: Session, user: CurrentUser | None, action: str, resource: str = "", **details) -> None:
    db.add(
        AuditLog(
            tenant_id=user.tenant_id if user else "system",
            user_id=user.id if user else None,
            action=action,
            resource=resource,
            details=details,
        )
    )
