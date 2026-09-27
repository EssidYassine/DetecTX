"""Processus (page Système) : pas de pseudo-processus d'inactivité, détails présents, PID borné."""

from fastapi.testclient import TestClient

from app.deps import get_current_user
from app.main import app
from app.models.user import Role, User
from app.services import metrics as svc


def test_top_processes_excludes_idle_and_has_details():
    procs = svc.top_processes(500)
    assert procs, "au moins un processus attendu"
    assert all(p["pid"] != 0 for p in procs)
    assert {"rss", "username", "exe", "status", "started_at"} <= procs[0].keys()
    mems = [p["memory_percent"] for p in procs]
    assert mems == sorted(mems, reverse=True)


def test_kill_rejects_protected_and_invalid_pids():
    analyst = User(email="analyst@test.local", role=Role.analyst, hashed_password="x")
    app.dependency_overrides[get_current_user] = lambda: analyst
    try:
        client = TestClient(app)
        assert client.post("/metrics/processes/4/kill").status_code == 400  # « System » protégé
        assert client.post("/metrics/processes/0/kill").status_code == 422  # hors bornes
        assert client.post("/metrics/processes/-5/kill").status_code == 422
    finally:
        app.dependency_overrides.clear()
