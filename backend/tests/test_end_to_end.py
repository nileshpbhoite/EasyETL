"""Full user journey through the API: connect → analyze → transform → configure → design → review → deploy → monitor."""
from tests.conftest import auth


def test_full_journey(client):
    h = auth(client)
    p = client.post("/api/pipelines", json={"name": "Test pipeline"}, headers=h).json()
    pid = p["id"]

    f1 = client.post("/api/demo-files/Customer_Data.xlsx/import", headers=h).json()
    f2 = client.post("/api/demo-files/Orders.csv/import", headers=h).json()
    assert f1["detection"]["summary"][1] == "4 sheets found."

    r = client.post(f"/api/pipelines/{pid}/source", json={"connector": "file_upload", "file_ids": [f1["id"], f2["id"]]}, headers=h).json()
    datasets = r["metadata"]["source"]["datasets"]
    assert r["test"]["ok"] and len(datasets) == 5
    cust = next(d for d in datasets if d["name"].endswith("Customers"))
    orders = next(d for d in datasets if d["name"] == "Orders")

    r = client.post(f"/api/pipelines/{pid}/analyze", headers=h).json()
    meta = r["metadata"]
    assert meta["analysis"]["profiles"][cust["id"]]["primary_key_candidates"][0]["column"] == "Customer_ID"
    titles = [x["title"] for x in meta["recommendations"]]
    assert "Remove duplicate Customer_ID records" in titles
    assert any(x["from_column"] == "customer_id" for x in meta["analysis"]["relationships"])
    assert meta["ingestion"]["engine"] == "auto_loader"
    assert any(t["name"] == "customer_360" for t in meta["lakehouse"]["tables"])

    rec = next(x for x in meta["recommendations"] if x["title"] == "Remove duplicate Customer_ID records")
    pv = client.post(f"/api/pipelines/{pid}/recommendations/{rec['id']}/preview", headers=h).json()
    assert pv["changes"]["rows_removed"] == 62
    assert pv["after"]["metrics"]["quality_score"] > pv["before"]["metrics"]["quality_score"]

    r = client.post(f"/api/pipelines/{pid}/recommendations/apply", json={"ids": None}, headers=h).json()
    assert len(r["result"]["applied"]) >= 15 and not r["result"]["failed"]

    # manual step with the visual expression builder
    expr = {"type": "func", "name": "concat", "args": [{"type": "column", "name": "first_name"}, {"type": "literal", "value": " "}, {"type": "column", "name": "last_name"}]}
    r = client.post(f"/api/pipelines/{pid}/transformations", json={"dataset_id": cust["id"], "type": "derive_column", "params": {"output": "full_name", "expression": expr}}, headers=h)
    assert r.status_code == 200, r.text
    step_id = r.json()["step_id"]
    pv = client.post(f"/api/pipelines/{pid}/preview", json={"dataset_id": cust["id"], "step_id": step_id}, headers=h).json()
    assert "full_name" in pv["changes"]["added_columns"]

    # invalid step is rejected by the policy engine with a friendly message
    r = client.post(f"/api/pipelines/{pid}/transformations", json={"dataset_id": cust["id"], "type": "uppercase", "params": {"columns": ["Nope"]}}, headers=h)
    assert r.status_code == 400 and "doesn't exist" in r.json()["error"]["message"] or "not found" in r.json()["error"]["message"]

    # join with the other dataset
    r = client.post(f"/api/pipelines/{pid}/transformations", json={"dataset_id": orders["id"], "type": "join", "params": {
        "right_dataset": cust["id"], "left_on": ["customer_id"], "right_on": ["customer_id"], "how": "left", "columns": ["country"]}}, headers=h)
    assert r.status_code == 200, r.text

    q = client.get(f"/api/pipelines/{pid}/quality", headers=h).json()
    c = next(d for d in q["datasets"] if d["dataset_id"] == cust["id"])
    assert c["after"]["score"] >= c["before"]["score"]

    client.put(f"/api/pipelines/{pid}/ingestion", json={"frequency": "hourly"}, headers=h)
    hc = client.post(f"/api/pipelines/{pid}/health-check", headers=h).json()["health"]
    assert hc["ready"], hc

    bundle = client.get(f"/api/pipelines/{pid}/bundle", headers=h).json()["files"]
    assert "databricks.yml" in bundle and "GRANT SELECT" in bundle["governance/unity_catalog.sql"]

    d = client.post(f"/api/pipelines/{pid}/deploy", json={"environment": "development"}, headers=h).json()
    assert d["metadata"]["deployment"]["status"] == "deployed"
    m = client.get(f"/api/pipelines/{pid}/monitoring", headers=h).json()
    assert m["summary"]["run_count"] > 10 and m["alerts"]

    lin = client.get(f"/api/pipelines/{pid}/lineage", headers=h).json()
    types = {n["type"] for n in lin["nodes"]}
    assert {"source", "raw", "bronze", "transformation", "silver", "gold", "dashboard"} <= types

    cat = client.get("/api/catalog", headers=h).json()
    assert cat and any(s["layer"] == "gold" for s in cat[0]["schemas"])

    a = client.post(f"/api/pipelines/{pid}/assistant", json={"question": "Why is Customer_ID considered the primary key?", "dataset_id": cust["id"]}, headers=h).json()
    assert "Customer_ID" in a["answer"]
    a = client.post(f"/api/pipelines/{pid}/assistant", json={"question": "Create a customer age column", "dataset_id": cust["id"]}, headers=h).json()
    assert a["answer"]

    before = client.get(f"/api/pipelines/{pid}", headers=h).json()["metadata"]["ingestion"]["frequency"]
    client.put(f"/api/pipelines/{pid}/ingestion", json={"frequency": "weekly"}, headers=h)
    undone = client.post(f"/api/pipelines/{pid}/undo", headers=h).json()
    assert undone["metadata"]["ingestion"]["frequency"] == before

    t = client.post(f"/api/pipelines/{pid}/save-template", json={"name": "My template"}, headers=h).json()
    assert any(x["id"] == t["id"] for x in client.get("/api/templates", headers=h).json())


def test_rbac_viewer_cannot_edit(client):
    h = auth(client, "viewer")
    r = client.post("/api/pipelines", json={"name": "x"}, headers=h)
    assert r.status_code == 403
    assert r.json()["error"]["title"] == "Not allowed"


def test_connectors_and_secrets(client):
    h = auth(client)
    r = client.post("/api/connections/test", json={"connector": "sqlserver", "config": {"host": "demo", "database": "dms"}}, headers=h).json()
    assert r["ok"] and r["info"]["Tables available"] == 3
    r = client.post("/api/connections", json={"connector": "rest_api", "auth_method": "bearer", "config": {"url": "demo://recalls", "token": "s3cret"},
                                              "secrets": {}}, headers=h).json()
    conns = client.get("/api/connections", headers=h).json()
    saved = next(c for c in conns if c["id"] == r["id"])
    assert "token" not in saved["config"] and saved["has_secrets"]
    bad = client.post("/api/connections/test", json={"connector": "postgresql", "config": {"host": "127.0.0.1", "port": 1, "database": "x"},
                                                     "secrets": {"username": "u", "password": "p"}}, headers=h).json()
    assert not bad["ok"] and "HTTP" not in bad["message"]
