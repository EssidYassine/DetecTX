"""Page Système : processus, réseau, arrêt (forcé / arborescence / fermeture propre).

Les tests d'arrêt ne visent que des processus Python jetables lancés par le test lui-même.
"""

import os
import subprocess
import sys
import time

import psutil
import pytest
from fastapi.testclient import TestClient

from app.deps import get_current_user
from app.main import app
from app.models.user import Role, User
from app.services import authenticode, winproc
from app.services import metrics as svc

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="API fenêtres Windows")


def _spawn(code: str) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", code])


def _wait_children(pid: int, n: int, timeout: float = 10.0) -> list[psutil.Process]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        kids = psutil.Process(pid).children()
        if len(kids) >= n:
            return kids
        time.sleep(0.1)
    raise AssertionError("sous-processus non démarré")


def _gone(p: psutil.Process) -> bool:
    try:
        return not p.is_running() or p.status() == psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return True


PARENT_WITH_CHILD = (
    "import subprocess,sys,time;"
    "subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']);"
    "time.sleep(60)"
)


# ─────────────────────────────── inventaire
def test_top_processes_excludes_idle_and_has_details():
    procs = svc.top_processes(500)
    assert procs, "au moins un processus attendu"
    assert all(p["pid"] != 0 for p in procs)
    assert {"ppid", "rss", "io_bps", "threads", "windows", "username", "exe", "status", "started_at"} <= procs[0].keys()
    mems = [p["memory_percent"] for p in procs]
    assert mems == sorted(mems, reverse=True)


@pytest.mark.skipif(not winproc.SUPPORTED, reason="instantané natif Windows x64")
def test_native_snapshot_matches_psutil():
    # Verrouille les offsets des structures NT : parent, date de création, threads, nom.
    # Les signatures des exécutables se vérifient dans un thread d'arrière-plan : on attend
    # qu'il ait fini, sinon le nombre de threads change entre les deux mesures.
    assert authenticode.wait_idle()
    snap = {r.pid: r for r in winproc.snapshot()}
    me = psutil.Process()
    raw = snap[me.pid]
    assert raw.name == me.name()
    assert raw.ppid == me.ppid()
    assert raw.create_time == pytest.approx(me.create_time(), abs=0.01)
    assert raw.threads == me.num_threads()
    assert raw.rss == pytest.approx(me.memory_info().rss, rel=0.2)
    assert raw.cpu_seconds >= 0 and not raw.suspended
    assert snap[4].name == "System"


def test_native_cpu_rate_detects_busy_process():
    busy = _spawn("while True: pass")
    try:
        svc.top_processes(2000)  # référence
        time.sleep(1.5)
        procs = {p["pid"]: p for p in svc.top_processes(2000)}
        assert procs[busy.pid]["cpu_percent"] > 50  # une boucle infinie ≈ 100 % d'un cœur
    finally:
        busy.kill()


@pytest.mark.parametrize(
    ("ip", "scope"),
    [
        ("127.0.0.1", "loopback"),
        ("::1", "loopback"),
        ("192.168.1.20", "private"),
        ("10.0.0.5", "private"),
        ("fe80::1%12", "private"),
        ("8.8.8.8", "public"),
        ("::ffff:8.8.8.8", "public"),
        ("224.0.0.251", "other"),
        ("0.0.0.0", "other"),
        ("pas-une-ip", "other"),
    ],
)
def test_scope(ip, scope):
    assert svc._scope(ip) == scope


def test_connections_shape():
    snap = svc.connections()
    assert {"listening", "connections", "truncated", "loopback", "timestamp"} <= snap.keys()
    for c in snap["connections"]:
        assert c["scope"] != "loopback"  # l'IPC locale est comptée, pas listée
    for s in snap["listening"]:
        assert s["exposed"] == (svc._scope(s["ip"]) != "loopback")


# ─────────────────────────────── protections
class _FakeProc:
    def __init__(self, name, exe):
        self.pid = 999_999
        self._name, self._exe = name, exe

    def name(self):
        return self._name

    def exe(self):
        if isinstance(self._exe, Exception):
            raise self._exe
        return self._exe


def test_critical_processes_protected_only_when_genuine():
    system32 = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    assert svc._is_critical(_FakeProc("lsass.exe", os.path.join(system32, "lsass.exe")))
    assert svc._is_critical(_FakeProc("csrss.exe", psutil.AccessDenied()))  # chemin illisible
    # Un « lsass.exe » hors de System32 est un leurre : il doit rester arrêtable.
    assert not svc._is_critical(_FakeProc("lsass.exe", r"C:\Users\x\AppData\Local\Temp\lsass.exe"))
    assert not svc._is_critical(_FakeProc("notepad.exe", r"C:\Windows\System32\notepad.exe"))


def test_tree_kill_refused_when_it_contains_detectx():
    # L'ancêtre du processus de test contient DeTecTX (= ce processus) : refus AVANT toute action.
    with pytest.raises(svc.KillError) as exc:
        svc._kill_plan(os.getppid(), tree=True)
    assert exc.value.status == 400


# ─────────────────────────────── arrêt forcé
def test_force_kill_leaves_children_alive():
    parent = _spawn(PARENT_WITH_CHILD)
    child = _wait_children(parent.pid, 1)[0]
    try:
        result = svc.kill_process(parent.pid)
        assert result["killed"] and [p["pid"] for p in result["tree"]] == [parent.pid]
        assert _gone(psutil.Process(parent.pid)) if psutil.pid_exists(parent.pid) else True
        assert child.is_running()
    finally:
        child.kill()


def test_force_kill_tree_kills_descendants():
    parent = _spawn(PARENT_WITH_CHILD)
    child = _wait_children(parent.pid, 1)[0]
    result = svc.kill_process(parent.pid, tree=True)
    assert {p["pid"] for p in result["tree"]} == {parent.pid, child.pid}
    assert result["failed"] == []
    assert _gone(child)


# ─────────────────────────────── fermeture propre
@windows_only
def test_close_without_window_is_rejected():
    proc = _spawn("import time; time.sleep(60)")
    try:
        time.sleep(0.5)
        with pytest.raises(svc.KillError) as exc:
            svc.close_process(proc.pid)
        assert exc.value.status == 409
        assert proc.poll() is None  # rien n'a été tué
    finally:
        proc.kill()


@windows_only
def test_close_sends_wm_close_to_window():
    pytest.importorskip("tkinter")
    # Petite fenêtre hors écran qui se ferme d'elle-même au WM_CLOSE (comportement par défaut).
    proc = _spawn("import tkinter as tk; r = tk.Tk(); r.geometry('120x60+-3000+-3000'); r.mainloop()")
    try:
        deadline = time.monotonic() + 10
        while not svc._main_windows(proc.pid) and time.monotonic() < deadline:
            time.sleep(0.2)
        # La fenêtre est comptée dans l'inventaire : l'UI sait quel processus la possède.
        listed = {p["pid"]: p for p in svc.top_processes(2000)}
        assert listed[proc.pid]["windows"] == 1
        result = svc.close_process(proc.pid, wait=5)
        assert result["windows"] >= 1 and result["exited"] is True
    finally:
        if proc.poll() is None:
            proc.kill()


# ─────────────────────────────── API
@pytest.fixture
def analyst_client():
    analyst = User(email="analyst@test.local", role=Role.analyst, hashed_password="x")
    app.dependency_overrides[get_current_user] = lambda: analyst
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def test_kill_rejects_protected_and_invalid_pids(analyst_client):
    assert analyst_client.post("/metrics/processes/4/kill").status_code == 400  # « System »
    assert analyst_client.post("/metrics/processes/4/kill?tree=true").status_code == 400
    assert analyst_client.post("/metrics/processes/0/kill").status_code == 422  # hors bornes
    assert analyst_client.post("/metrics/processes/-5/close").status_code == 422


def test_refused_kill_is_audited(analyst_client, caplog):
    with caplog.at_level("INFO", logger="detectx.audit"):
        analyst_client.post("/metrics/processes/4/kill?tree=true")
    line = next(r.getMessage() for r in caplog.records if r.name == "detectx.audit")
    assert "process_kill" in line and "actor=analyst@test.local" in line and "refused=400" in line


def test_viewer_cannot_stop_processes():
    viewer = User(email="viewer@test.local", role=Role.viewer, hashed_password="x")
    app.dependency_overrides[get_current_user] = lambda: viewer
    try:
        client = TestClient(app)
        assert client.post("/metrics/processes/999999/kill").status_code == 403
        assert client.post("/metrics/processes/999999/close").status_code == 403
    finally:
        app.dependency_overrides.clear()


def test_connections_endpoint(analyst_client):
    res = analyst_client.get("/metrics/connections")
    assert res.status_code == 200 and "listening" in res.json()
