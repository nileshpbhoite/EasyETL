from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Runtime configuration. Every value can be overridden with an EASYETL_* env var."""

    model_config = SettingsConfigDict(env_prefix="EASYETL_", env_file=".env", extra="ignore")

    app_name: str = "EasyETL"
    environment: str = "development"  # development | staging | production

    # Application metadata store (PostgreSQL in production, SQLite for local dev)
    database_url: str = f"sqlite:///{BASE_DIR / 'data' / 'easyetl.db'}"

    # Object storage (local directory in dev; S3/ADLS/GCS adapters plug in via storage.py)
    storage_backend: str = "local"
    storage_root: Path = BASE_DIR / "data" / "storage"

    # Security
    jwt_secret: str = "change-me-in-production-please-32bytes!!"
    jwt_algorithm: str = "HS256"
    jwt_expiry_minutes: int = 60 * 12
    # Fernet key for secrets-at-rest. Generated into data/.secret_key when not provided.
    secrets_key: str | None = None
    allow_demo_login: bool = True

    # Profiling: files larger than this are profiled by Databricks instead of the API server
    local_profile_max_bytes: int = 200 * 1024 * 1024
    profile_sample_rows: int = 200_000
    preview_rows: int = 200

    # AI provider: "heuristic" (deterministic expert engine) or "anthropic"
    ai_provider: str = "heuristic"
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-opus-5"

    # Databricks. When host/token are missing the deployer runs in safe mock mode.
    databricks_host: str | None = None
    databricks_token: str | None = None
    databricks_default_catalog: str = "easyetl"

    cors_origins: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.storage_root.mkdir(parents=True, exist_ok=True)
    (BASE_DIR / "data").mkdir(parents=True, exist_ok=True)
    return s
