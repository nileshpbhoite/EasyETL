"""EasyETL API — Connect Anything. Modernize Automatically. Deploy to Databricks."""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import auth, connectors, files, misc, pipelines
from .core.config import get_settings
from .core.db import SessionLocal, init_db
from .core.errors import install_error_handlers

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="EasyETL API", version="1.0.0", description="No-code, AI-powered data integration and modernization for Databricks.")
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
    install_error_handlers(app)
    for r in (auth.router, files.router, connectors.router, pipelines.router, misc.router):
        app.include_router(r)

    @app.get("/api/health")
    def health():
        return {"status": "ok", "app": settings.app_name, "environment": settings.environment}

    @app.on_event("startup")
    def _startup() -> None:
        init_db()
        from .demo.generate import DATA_DIR, generate

        if not (DATA_DIR / "Customer_Data.xlsx").exists() or not (DATA_DIR / "demo_dealer_db.sqlite").exists():
            generate()
        if os.environ.get("EASYETL_SEED_DEMO", "true").lower() == "true":
            from .demo.seed import seed

            with SessionLocal() as db:
                seed(db)

    return app


app = create_app()
