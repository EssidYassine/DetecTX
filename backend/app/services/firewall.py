"""Exposition effective des ports : sockets en écoute × règles du pare-feu Windows Defender.

DeTecTX ne remplace pas le pare-feu : il explique ce que le pare-feu laisse passer. Un port
lié à 0.0.0.0 n'est joignable que si une règle entrante l'autorise sur le profil réseau actif.

Lecture seule, sans droits administrateur :
- règles et profils : API COM HNetCfg.FwPolicy2 (~130 ms pour ~800 règles, mis en cache) ;
- réseau connecté et sa catégorie : INetworkListManager ;
- services hébergés par chaque PID (règles « service ») : EnumServicesStatusEx (~8 ms).

L'évaluation (evaluate) est une fonction pure, testable hors Windows. Elle reprend les
principes du pare-feu Windows : une règle Block l'emporte sur une règle Allow ; sans règle,
l'action par défaut du profil s'applique (Block par défaut pour l'entrant). Elle reste une
approximation assumée : sécurité IPsec, edge traversal et stratégies de groupe ne sont pas
évalués finement -> verdict « unknown » quand une correspondance n'est pas certaine.
"""

import ipaddress
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import psutil

from app.detection.port_risk import LEVELS, assess
from app.services import fw_helper, metrics

PROFILE_BITS = {1: "domain", 2: "private", 4: "public"}
_PROTO_NUM = {"tcp": 6, "udp": 17}
_ANY_PROTO = 256
_CACHE_TTL = 15.0  # s : les règles changent rarement ; lecture COM ~130 ms
# Ports « mots-clés » du pare-feu Windows et ce qu'ils couvrent (approximatif -> verdict incertain).
_KEYWORD_PORTS = {
    "rpc": range(49152, 65536),
    "rpc-epmap": range(135, 136),
    "iphttps": range(443, 444),
    "teredo": range(3544, 3545),
    "mdns": range(5353, 5354),
}


# ─────────────────────────────── modèle
@dataclass(frozen=True)
class FwRule:
    name: str
    allow: bool
    profiles: int  # masque de bits : 1 domaine, 2 privé, 4 public
    protocol: int  # 6 TCP, 17 UDP, 256 tous
    ports: tuple[tuple[int, int], ...] = ()  # plages ; vide + any_port = tous les ports
    any_port: bool = True
    keywords: tuple[str, ...] = ()
    program: str | None = None  # chemin normalisé ; None = tous les programmes
    service: str | None = None  # nom court en minuscules ; None = tous
    remote: str = "*"
    group: str = ""
    # Règle d'application empaquetée (Store / MSIX) : ne s'applique qu'à son conteneur.
    packaged: bool = False
    # Autorisation conditionnée à IPsec (« autoriser si sécurisé ») : incertain sans analyse IPsec.
    secure: bool = False
    # Interfaces précises (ex. commutateur virtuel WSL) : la règle n'ouvre pas les autres réseaux.
    interfaces: tuple[str, ...] = ()


@dataclass
class FwState:
    available: bool
    active: int = 0  # masque des profils actifs
    enabled: dict[int, bool] = field(default_factory=dict)
    default_block: dict[int, bool] = field(default_factory=dict)
    block_all: dict[int, bool] = field(default_factory=dict)
    rules: list[FwRule] = field(default_factory=list)
    networks: list[dict] = field(default_factory=list)
    error: str | None = None


@dataclass(frozen=True)
class Listener:
    proto: str
    ip: str
    port: int
    pid: int | None
    process: str | None
    exe: str | None


@dataclass
class Verdict:
    verdict: str  # open | blocked | local | unknown
    scope: str | None  # any | local_subnet | restricted | None
    reason: str
    rules: list[dict] = field(default_factory=list)


# ─────────────────────────────── évaluation (pure)
def _norm_path(path: str | None) -> str | None:
    if not path or path == "*":
        return None
    return os.path.normcase(os.path.expandvars(path))


def _is_loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _port_match(rule: FwRule, port: int) -> str:
    """yes | maybe (mot-clé) | no"""
    if rule.any_port:
        return "yes"
    if any(lo <= port <= hi for lo, hi in rule.ports):
        return "yes"
    if any(port in _KEYWORD_PORTS.get(k, ()) for k in rule.keywords):
        return "maybe"
    return "no"


def _program_match(rule: FwRule, sock: Listener) -> str:
    if rule.program is None:
        return "yes"
    if rule.program == "system":  # règles noyau (SMB, NetBIOS) : ApplicationName = « System »
        return "yes" if sock.pid == 4 else "no"
    if sock.exe is None:
        return "maybe"  # chemin illisible sans droits admin : impossible de trancher
    return "yes" if _norm_path(sock.exe) == rule.program else "no"


def _rule_scope(rule: FwRule) -> str:
    if rule.interfaces:
        return "restricted"
    tokens = [t.strip().lower() for t in (rule.remote or "*").split(",")]
    if any(t in ("*", "") for t in tokens):
        return "any"
    if all(t in ("localsubnet", "local subnet") for t in tokens):
        return "local_subnet"
    return "restricted"


def _scope(rules: list[FwRule]) -> str:
    """La portée la plus large parmi les règles qui autorisent : c'est elle qui compte."""
    found = {_rule_scope(r) for r in rules}
    return next(s for s in ("any", "local_subnet", "restricted") if s in found)


def _describe(rule: FwRule) -> dict:
    return {
        "name": rule.name,
        "action": "allow" if rule.allow else "block",
        "profiles": [name for bit, name in PROFILE_BITS.items() if rule.profiles & bit],
        "remote": rule.remote or "*",
        "by": "programme" if rule.program else "service" if rule.service else "port",
        "group": rule.group,
        "interfaces": list(rule.interfaces),
    }


def evaluate(sock: Listener, state: FwState, services: dict[int, set[str]]) -> Verdict:
    if _is_loopback(sock.ip):
        return Verdict("local", None, "Lié à l'adresse de bouclage : inaccessible depuis le réseau.")
    if not state.available:
        return Verdict("unknown", None, "Règles du pare-feu illisibles : exposition non déterminée.")

    active = [bit for bit in PROFILE_BITS if state.active & bit]
    for bit in active:
        if not state.enabled.get(bit, True):
            return Verdict("open", "any", f"Le pare-feu est désactivé sur le profil {PROFILE_BITS[bit]} actif.")
    if active and all(state.block_all.get(bit, False) for bit in active):
        return Verdict("blocked", None, "« Bloquer toutes les connexions entrantes » est activé.")

    proto = _PROTO_NUM.get(sock.proto)
    sure: list[FwRule] = []
    unsure: list[FwRule] = []
    for rule in state.rules:
        if not rule.profiles & state.active:
            continue
        if rule.protocol not in (_ANY_PROTO, proto):
            continue
        if rule.packaged:  # nos écouteurs sont des programmes classiques, pas des apps du Store
            continue
        if rule.service is not None and rule.service not in services.get(sock.pid or -1, set()):
            continue
        port_m, prog_m = _port_match(rule, sock.port), _program_match(rule, sock)
        if "no" in (port_m, prog_m):
            continue
        certain = port_m == prog_m == "yes" and not (rule.allow and rule.secure)
        (sure if certain else unsure).append(rule)

    blocks = [r for r in sure if not r.allow]
    if blocks:
        return Verdict("blocked", None, f"Bloqué par la règle « {blocks[0].name} ».", [_describe(r) for r in blocks])
    allows = [r for r in sure if r.allow]
    if allows:
        scope = _scope(allows)
        widest = next(r for r in allows if _rule_scope(r) == scope)
        if widest.interfaces:
            where = f"sur l'interface « {widest.interfaces[0]} » seulement"
        else:
            where = {"any": "depuis toute adresse", "local_subnet": "depuis le réseau local seulement", "restricted": "depuis des adresses précises"}[scope]
        return Verdict("open", scope, f"Autorisé par la règle « {widest.name} » {where}.", [_describe(r) for r in allows])
    if unsure:
        return Verdict(
            "unknown",
            None,
            f"La règle « {unsure[0].name} » pourrait l'autoriser (chemin du programme ou port non vérifiables).",
            [_describe(r) for r in unsure],
        )
    if active and all(state.default_block.get(bit, True) for bit in active):
        return Verdict("blocked", None, "Aucune règle ne l'autorise : bloqué par défaut par le pare-feu.")
    return Verdict("open", "any", "Aucune règle, mais l'action par défaut du profil autorise l'entrant.")


# ─────────────────────────────── lecture Windows (COM)
def _parse_ports(raw: str) -> tuple[bool, tuple[tuple[int, int], ...], tuple[str, ...]]:
    raw = (raw or "*").strip()
    if raw == "*":
        return True, (), ()
    spans, keywords = [], []
    for token in (t.strip() for t in raw.split(",")):
        if not token:
            continue
        lo, _, hi = token.partition("-")
        if lo.isdigit() and (not hi or hi.isdigit()):
            spans.append((int(lo), int(hi or lo)))
        else:
            keywords.append(token.lower())
    return False, tuple(spans), tuple(keywords)


def _service(raw: str | None) -> str | None:
    """Nom court du service ciblé par une règle ; None si la règle vaut pour tous (« * » ou vide)."""
    name = (raw or "").strip().lower()
    return None if name in ("", "*") else name


def _rule_from_com(r) -> FwRule | None:
    if r.Direction != 1 or not r.Enabled:  # entrant et actif seulement
        return None
    any_port, spans, keywords = _parse_ports(r.LocalPorts)
    app = (r.ApplicationName or "").strip()
    try:  # INetFwRule3 (Windows 8+) : conteneur d'application, IPsec
        packaged = bool(r.LocalAppPackageId or r.LocalUserOwner)
        secure = bool(r.SecureFlags)
    except AttributeError:
        packaged = secure = False
    interfaces = tuple(str(i) for i in (r.Interfaces or ()))
    return FwRule(
        name=r.Name,
        allow=int(r.Action) == 1,
        profiles=int(r.Profiles),
        protocol=int(r.Protocol),
        ports=spans,
        any_port=any_port,
        keywords=keywords,
        program="system" if app.lower() == "system" else _norm_path(app),
        service=_service(r.ServiceName),
        remote=(r.RemoteAddresses or "*"),
        group=r.Grouping or "",
        packaged=packaged,
        secure=secure,
        interfaces=interfaces,
    )


def _collect() -> FwState:
    """Lecture COM. Tous les objets COM sont locaux : libérés au retour, AVANT CoUninitialize."""
    import win32com.client

    fw = win32com.client.Dispatch("HNetCfg.FwPolicy2")
    state = FwState(available=True, active=int(fw.CurrentProfileTypes))
    for bit in PROFILE_BITS:
        state.enabled[bit] = bool(fw.FirewallEnabled(bit))
        state.default_block[bit] = int(fw.DefaultInboundAction(bit)) == 0
        state.block_all[bit] = bool(fw.BlockAllInboundTraffic(bit))
    state.rules = [rule for r in fw.Rules if (rule := _rule_from_com(r)) is not None]
    state.networks = _networks_com()
    return state


def _networks_com() -> list[dict]:
    """Réseaux connectés et leur catégorie (INetworkListManager). COM déjà initialisé."""
    import win32com.client

    try:
        nlm = win32com.client.Dispatch("{DCB00C01-570F-4A9B-8D69-199FDBA5723B}")
        category = {0: "public", 1: "private", 2: "domain"}
        return [{"name": n.GetName(), "category": category.get(int(n.GetCategory()), "public")} for n in nlm.GetNetworks(1)]
    except Exception:  # noqa: BLE001 - le nom du réseau est un plus, pas une nécessité
        return []


def _with_com(read):
    import pythoncom

    pythoncom.CoInitialize()  # chaque thread du pool FastAPI a son propre appartement COM
    try:
        return read()
    finally:
        pythoncom.CoUninitialize()


def _read_windows() -> FwState:
    return _with_com(_collect)


def connected_networks() -> list[dict]:
    """Réseaux connectés seuls (sans relire les règles du pare-feu) : [{name, category}]."""
    if sys.platform != "win32":
        return []
    try:
        return _with_com(_networks_com)
    except ImportError:
        return []


def _services_by_pid() -> dict[int, set[str]]:
    import win32service

    scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_ENUMERATE_SERVICE)
    try:
        entries = win32service.EnumServicesStatusEx(scm, win32service.SERVICE_WIN32, win32service.SERVICE_ACTIVE)
    finally:
        win32service.CloseServiceHandle(scm)
    out: dict[int, set[str]] = {}
    for e in entries:
        if e["ProcessId"]:
            out.setdefault(e["ProcessId"], set()).add(e["ServiceName"].lower())
    return out


_cache: tuple[float, FwState, dict[int, set[str]]] | None = None
_lock = threading.Lock()


def read_state(force: bool = False) -> tuple[FwState, dict[int, set[str]]]:
    """État du pare-feu + services par PID, mis en cache _CACHE_TTL secondes."""
    global _cache
    with _lock:
        if not force and _cache and time.monotonic() - _cache[0] < _CACHE_TTL:
            return _cache[1], _cache[2]
        if sys.platform != "win32":
            state, services = FwState(available=False, error="Pare-feu Windows : disponible uniquement sous Windows."), {}
        else:
            try:
                state, services = _read_windows(), _services_by_pid()
            except ImportError:
                state, services = FwState(available=False, error="Module pywin32 absent : pip install pywin32."), {}
            except Exception as e:  # noqa: BLE001 - un pare-feu illisible ne doit pas casser la page
                state, services = FwState(available=False, error=f"Lecture du pare-feu impossible : {e.__class__.__name__}."), {}
        _cache = (time.monotonic(), state, services)
        return state, services


# ─────────────────────────────── inventaire exposé à l'API
_RANK = {"open": 0, "unknown": 1, "blocked": 2, "local": 3}
_OPENNESS = {"open": 3, "unknown": 2, "blocked": 1, "local": 0}


def _listeners() -> list[Listener]:
    """Ports en écoute : tout le TCP, et l'UDP hors plage éphémère (surtout des sockets clients)."""
    snap = metrics.connections()
    exes: dict[int, str | None] = {}
    out = []
    for s in snap["listening"]:
        if s["proto"] == "udp" and s["port"] >= 49152:
            continue
        pid = s["pid"]
        if pid is not None and pid not in exes:
            try:
                exes[pid] = psutil.Process(pid).exe() or None
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                exes[pid] = None
        out.append(Listener(s["proto"], s["ip"], s["port"], pid, s["process"], exes.get(pid)))
    return out


def exposure() -> dict:
    state, services = read_state()
    public = bool(state.active & 4)
    groups: dict[tuple, dict] = {}
    for sock in _listeners():
        key = (sock.proto, sock.port, sock.pid)
        v = evaluate(sock, state, services)
        entry = groups.get(key)
        if entry is None:
            entry = groups[key] = {
                "proto": sock.proto,
                "port": sock.port,
                "pid": sock.pid,
                "process": sock.process,
                "exe": sock.exe,
                "binds": [],
                "_v": v,
            }
        if sock.ip not in entry["binds"]:
            entry["binds"].append(sock.ip)
        if _OPENNESS[v.verdict] > _OPENNESS[entry["_v"].verdict]:
            entry["_v"] = v  # le verdict le plus ouvert parmi les adresses de liaison

    ports = []
    for entry in groups.values():
        v: Verdict = entry.pop("_v")
        risk = assess(entry["proto"], entry["port"], entry["process"], v.verdict, v.scope, public)
        ports.append(
            {
                **entry,
                "verdict": v.verdict,
                "scope": v.scope,
                "reason": v.reason,
                "rules": v.rules[:5],
                "risk": {"level": risk.level, "service": risk.service, "why": risk.why, "attack": risk.attack, "advice": risk.advice},
            }
        )
    ports.sort(key=lambda p: (_RANK[p["verdict"]], -LEVELS.index(p["risk"]["level"]), p["port"]))

    summary = {k: sum(1 for p in ports if p["verdict"] == k) for k in _RANK}
    summary.update({lvl: sum(1 for p in ports if p["risk"]["level"] == lvl) for lvl in LEVELS})
    return {
        "available": state.available,
        "error": state.error,
        "profiles": {
            "active": [name for bit, name in PROFILE_BITS.items() if state.active & bit],
            "states": {
                name: {
                    "enabled": state.enabled.get(bit),
                    "default_inbound": None if bit not in state.default_block else ("block" if state.default_block[bit] else "allow"),
                    "block_all": state.block_all.get(bit),
                }
                for bit, name in PROFILE_BITS.items()
            },
        },
        "networks": state.networks,
        "rules_count": len(state.rules),
        # Blocages posés par DeTecTX (groupe dédié) : ce sont les seuls que l'UI peut retirer.
        "detectx_rules": [
            {
                "name": r.name,
                "proto": {6: "tcp", 17: "udp"}.get(r.protocol, "any"),
                "ports": [p for lo, hi in r.ports for p in range(lo, hi + 1)][:20],
                "profiles": [name for bit, name in PROFILE_BITS.items() if r.profiles & bit],
            }
            for r in state.rules
            if r.group == fw_helper.GROUP and not r.allow
        ],
        "elevated": sys.platform == "win32" and fw_helper.is_admin(),
        "ports": ports,
        "summary": summary,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
