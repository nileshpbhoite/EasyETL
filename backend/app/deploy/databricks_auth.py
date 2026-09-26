"""Databricks authentication — every method supported by Databricks unified client auth.

    pat            Personal access token
    oauth_m2m      OAuth machine-to-machine with a Databricks service principal (client id + secret)
    azure_sp       Microsoft Entra ID service principal (tenant + client id + secret) — Azure Databricks
    azure_msi      Azure managed identity (system- or user-assigned) — when EasyETL runs on Azure
    azure_cli      Azure CLI login on the EasyETL server (`az login`)
    gcp_sa         Google Cloud service account key — Databricks on GCP
    cli_profile    A profile from the server's ~/.databrickscfg (any of the above, configured once)

`auth_headers()` returns the HTTP headers for REST calls. Tokens are fetched on demand and never stored.
"""
from __future__ import annotations

import base64
import configparser
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

AZURE_DATABRICKS_RESOURCE = "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d"  # well-known Azure Databricks application id
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

METHODS = {
    "pat": "Personal access token",
    "oauth_m2m": "OAuth service principal (M2M)",
    "azure_sp": "Microsoft Entra ID service principal",
    "azure_msi": "Azure managed identity",
    "azure_cli": "Azure CLI",
    "gcp_sa": "Google Cloud service account",
    "cli_profile": "Databricks CLI profile",
}


class DatabricksAuthError(RuntimeError):
    pass


def normalize_host(host: str) -> str:
    host = (host or "").strip().rstrip("/")
    if host and not host.startswith("http"):
        host = "https://" + host
    return host


def _form_token(url: str, data: dict, auth: tuple[str, str] | None = None) -> dict:
    r = httpx.post(url, data=data, auth=auth, timeout=30)
    if r.status_code >= 400:
        try:
            detail = r.json()
            msg = detail.get("error_description") or detail.get("error") or r.text
        except ValueError:
            msg = r.text
        raise DatabricksAuthError(f"Token request failed ({r.status_code}): {msg}")
    return r.json()


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _google_jwt(sa: dict, claims: dict) -> str:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT", "kid": sa.get("private_key_id", "")}
    body = {"iss": sa["client_email"], "sub": sa["client_email"], "aud": GOOGLE_TOKEN_URL, "iat": now, "exp": now + 3600, **claims}
    signing_input = f"{_b64url(json.dumps(header).encode())}.{_b64url(json.dumps(body).encode())}".encode()
    key = serialization.load_pem_private_key(sa["private_key"].encode(), password=None)
    sig = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())  # type: ignore[call-arg,union-attr]
    return f"{signing_input.decode()}.{_b64url(sig)}"


def _gcp_headers(host: str, sa_json: str) -> dict[str, str]:
    try:
        sa = json.loads(sa_json)
    except ValueError as e:
        raise DatabricksAuthError("The service account key isn't valid JSON.") from e
    if sa.get("type") != "service_account" or "private_key" not in sa:
        raise DatabricksAuthError("This isn't a service account key file (expected type 'service_account').")
    grant = "urn:ietf:params:oauth:grant-type:jwt-bearer"
    id_token = _form_token(GOOGLE_TOKEN_URL, {"grant_type": grant, "assertion": _google_jwt(sa, {"target_audience": host})})["id_token"]
    access = _form_token(GOOGLE_TOKEN_URL, {"grant_type": grant, "assertion": _google_jwt(sa, {"scope": "https://www.googleapis.com/auth/cloud-platform"})})["access_token"]
    return {"Authorization": f"Bearer {id_token}", "X-Databricks-GCP-SA-Access-Token": access}


def _profile(name: str) -> dict[str, str]:
    path = Path(os.environ.get("DATABRICKS_CONFIG_FILE", "~/.databrickscfg")).expanduser()
    cp = configparser.ConfigParser()
    if not cp.read(path):
        raise DatabricksAuthError(f"No Databricks config file found at {path} on the EasyETL server.")
    if name not in cp:
        raise DatabricksAuthError(f"Profile '{name}' isn't in {path}. Available: {', '.join(cp.sections()) or 'none'}.")
    return dict(cp[name])


def auth_headers(host: str, method: str, config: dict[str, Any], secrets: dict[str, Any]) -> dict[str, str]:
    host = normalize_host(host)
    if method == "pat":
        token = secrets.get("token")
        if not token:
            raise DatabricksAuthError("Enter a personal access token.")
        return {"Authorization": f"Bearer {token}"}
    if method == "oauth_m2m":
        cid, sec = config.get("client_id") or secrets.get("client_id"), secrets.get("client_secret")
        if not cid or not sec:
            raise DatabricksAuthError("Enter the service principal's client ID and OAuth secret.")
        tok = _form_token(f"{host}/oidc/v1/token", {"grant_type": "client_credentials", "scope": "all-apis"}, auth=(cid, sec))
        return {"Authorization": f"Bearer {tok['access_token']}"}
    if method == "azure_sp":
        tenant, cid, sec = config.get("tenant_id"), config.get("client_id"), secrets.get("client_secret")
        if not tenant or not cid or not sec:
            raise DatabricksAuthError("Enter the Entra ID tenant ID, client ID and client secret.")
        tok = _form_token(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
                          {"grant_type": "client_credentials", "client_id": cid, "client_secret": sec, "scope": f"{AZURE_DATABRICKS_RESOURCE}/.default"})
        return {"Authorization": f"Bearer {tok['access_token']}"}
    if method == "azure_msi":
        params = {"api-version": "2018-02-01", "resource": AZURE_DATABRICKS_RESOURCE}
        if config.get("client_id"):
            params["client_id"] = config["client_id"]
        try:
            r = httpx.get("http://169.254.169.254/metadata/identity/oauth2/token", params=params, headers={"Metadata": "true"}, timeout=5)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise DatabricksAuthError("No Azure managed identity is available where EasyETL is running (the instance metadata endpoint didn't answer).") from e
        return {"Authorization": f"Bearer {r.json()['access_token']}"}
    if method == "azure_cli":
        try:
            out = subprocess.run(["az", "account", "get-access-token", "--resource", AZURE_DATABRICKS_RESOURCE, "-o", "json"],
                                 capture_output=True, text=True, timeout=30, check=True)
        except FileNotFoundError as e:
            raise DatabricksAuthError("The Azure CLI isn't installed on the EasyETL server.") from e
        except subprocess.CalledProcessError as e:
            raise DatabricksAuthError(f"Azure CLI couldn't get a token — run 'az login' on the server. {e.stderr.strip()[:200]}") from e
        return {"Authorization": f"Bearer {json.loads(out.stdout)['accessToken']}"}
    if method == "gcp_sa":
        sa = secrets.get("service_account_json")
        if not sa:
            raise DatabricksAuthError("Paste the service account key (JSON).")
        return _gcp_headers(host, sa)
    if method == "cli_profile":
        p = _profile(config.get("profile") or "DEFAULT")
        if p.get("token"):
            return {"Authorization": f"Bearer {p['token']}"}
        if p.get("azure_tenant_id") and p.get("azure_client_id"):
            return auth_headers(host, "azure_sp", {"tenant_id": p["azure_tenant_id"], "client_id": p["azure_client_id"]}, {"client_secret": p.get("azure_client_secret")})
        if p.get("client_id"):
            return auth_headers(p.get("host") or host, "oauth_m2m", {"client_id": p["client_id"]}, {"client_secret": p.get("client_secret")})
        if p.get("auth_type") == "azure-cli":
            return auth_headers(host, "azure_cli", {}, {})
        raise DatabricksAuthError("That profile has no credentials EasyETL can use (token, service principal or azure-cli).")
    raise DatabricksAuthError(f"Unknown authentication method '{method}'.")


def warehouse_id_from(config: dict[str, Any]) -> str | None:
    """'/sql/1.0/warehouses/abc123' → 'abc123' (also accepts the bare id)."""
    raw = (config.get("http_path") or config.get("warehouse_id") or "").strip().rstrip("/")
    if not raw:
        return None
    return raw.split("/")[-1] if "/warehouses/" in raw or "/endpoints/" in raw else (raw if "/" not in raw else None)
