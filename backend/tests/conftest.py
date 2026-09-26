import os
import shutil
import tempfile

import pytest

_tmp = tempfile.mkdtemp(prefix="easyetl-test-")
os.environ["EASYETL_DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["EASYETL_STORAGE_ROOT"] = f"{_tmp}/storage"
os.environ["EASYETL_SEED_DEMO"] = "false"


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app.core.db import SessionLocal, init_db
    from app.demo.seed import seed
    from app.main import app

    with TestClient(app) as c:
        init_db()
        with SessionLocal() as db:
            seed(db, with_pipelines=False)
        yield c
    shutil.rmtree(_tmp, ignore_errors=True)


def auth(client, role="admin"):
    tok = client.post("/api/auth/demo", json={"role": role}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}
