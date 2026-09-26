from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy import select

from ..core.config import get_settings
from ..core.errors import FriendlyError
from ..core.models import User as UserRow
from ..core.security import PERMISSIONS, audit, create_access_token, verify_password
from .common import DB, User

router = APIRouter(prefix="/api/auth", tags=["auth"])

DEMO_USERS = {
    "admin": ("alex.morgan@northwind.example", "Alex Morgan"),
    "data_engineer": ("priya.shah@northwind.example", "Priya Shah"),
    "analyst": ("sam.lee@northwind.example", "Sam Lee"),
    "viewer": ("jordan.kim@northwind.example", "Jordan Kim"),
}


def _token_response(user: UserRow) -> dict:
    return {"access_token": create_access_token(user), "token_type": "bearer",
            "user": {"id": user.id, "email": user.email, "name": user.name, "role": user.role, "permissions": sorted(PERMISSIONS[user.role])}}


@router.post("/token")
def login(form: Annotated[OAuth2PasswordRequestForm, Depends()], db: DB):
    user = db.scalars(select(UserRow).where(UserRow.email == form.username.lower())).first()
    if not user or not verify_password(form.password, user.password_hash):
        raise FriendlyError("Sign-in failed", "The email or password is incorrect.", status_code=401)
    audit(db, None, "auth.login", user.id)
    db.commit()
    return _token_response(user)


class DemoLogin(BaseModel):
    role: str = "admin"


@router.post("/demo")
def demo_login(body: DemoLogin, db: DB):
    if not get_settings().allow_demo_login:
        raise FriendlyError("Demo sign-in disabled", "Please sign in with your organization account.", status_code=403)
    email = DEMO_USERS.get(body.role, DEMO_USERS["admin"])[0]
    user = db.scalars(select(UserRow).where(UserRow.email == email)).first()
    if not user:
        raise FriendlyError("Demo not initialized", "Restart the server to create demo users.", status_code=500)
    return _token_response(user)


@router.get("/me")
def me(user: User):
    return {**user.model_dump(), "permissions": sorted(PERMISSIONS[user.role])}


@router.get("/sso")
def sso_config():
    """SSO-ready: an OIDC/SAML identity provider can be configured per tenant; tokens are then exchanged for EasyETL JWTs."""
    return {"providers": [{"id": "oidc", "label": "Sign in with SSO (OIDC)", "enabled": False},
                          {"id": "azure_ad", "label": "Microsoft Entra ID", "enabled": False},
                          {"id": "okta", "label": "Okta", "enabled": False}],
            "demo_login": get_settings().allow_demo_login, "demo_roles": [{"role": r, "email": e, "name": n} for r, (e, n) in DEMO_USERS.items()]}
