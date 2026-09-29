"""Vulnérabilités de NOTRE système.

1. Mises à jour Windows manquantes : Agent Windows Update (COM, recherche seule, jamais
   d'installation). Lent (~1 min) : exécuté en tâche de fond, résultat mis en cache 12 h.
2. Logiciels installés (registre Uninstall) confrontés au catalogue CISA KEV (vulnérabilités
   ACTIVEMENT exploitées). Le KEV ne donne pas de versions : chaque candidat est vérifié auprès
   de l'API publique NVD (seul l'identifiant CVE est envoyé), qui fournit les plages vulnérables.
   Verdict : vulnerable (version installée dans la plage), fixed (déjà corrigée), unknown.
   Les produits Microsoft sont exclus du KEV : Windows Update les couvre (calibrage mesuré : la
   correspondance naïve donnait ~90 faux positifs).
"""

import asyncio
import json
import logging
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from app.config import get_settings
from app.net import CA_BUNDLE
from app.threatintel import feeds

log = logging.getLogger(__name__)
settings = get_settings()

NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"
NVD_DELAY = 6.5  # s entre deux requêtes sans clé (limite publique : 5 requêtes / 30 s)
MAX_NVD_PER_SCAN = 40
SCAN_EVERY = timedelta(hours=12)
EXCLUDED_VENDORS = {"microsoft"}  # couverts par Windows Update


def norm(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def version_tuple(v: str | None) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:6])


def cmp_versions(a: str, b: str) -> int:
    ta, tb = version_tuple(a), version_tuple(b)
    n = max(len(ta), len(tb))
    ta, tb = ta + (0,) * (n - len(ta)), tb + (0,) * (n - len(tb))
    return (ta > tb) - (ta < tb)


# ─────────────────────────────── logiciels installés
def installed_software() -> list[dict]:
    if sys.platform != "win32":
        return []
    import winreg

    roots = (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    )
    out: dict[str, dict] = {}
    for hive, path in roots:
        try:
            key = winreg.OpenKey(hive, path)
        except OSError:
            continue
        for i in range(winreg.QueryInfoKey(key)[0]):
            try:
                sub = winreg.OpenKey(key, winreg.EnumKey(key, i))
                name = str(winreg.QueryValueEx(sub, "DisplayName")[0]).strip()
            except OSError:
                continue

            def value(field: str, sub=sub) -> str:
                try:
                    return str(winreg.QueryValueEx(sub, field)[0]).strip()
                except OSError:
                    return ""

            if name and name not in out:
                out[name] = {"name": name, "version": value("DisplayVersion"), "publisher": value("Publisher")}
    return sorted(out.values(), key=lambda s: s["name"].lower())


# ─────────────────────────────── KEV × logiciels (pur)
def kev_candidates(software: list[dict], kev: list[dict]) -> list[tuple[dict, dict]]:
    """Paires (logiciel, entrée KEV) plausibles : produit présent comme suite de mots entière
    dans le nom, éditeur retrouvé dans le nom ou l'éditeur ; Microsoft et noms trop courts exclus."""
    out = []
    for entry in kev:
        vendor, product = norm(entry.get("vendorProject")), norm(entry.get("product"))
        if not product or len(product) < 4 or vendor in EXCLUDED_VENDORS or product == "windows":
            continue
        for sw in software:
            name, publisher = f" {norm(sw['name'])} ", norm(sw.get("publisher"))
            first = vendor.split()[0] if vendor else ""
            if f" {product} " in name and first and (f" {first} " in name or first in publisher):
                out.append((sw, entry))
    return out


# ─────────────────────────────── NVD (plages de versions)
def _nvd_dir() -> Path:
    d = Path(settings.intel_dir) / "nvd"
    d.mkdir(parents=True, exist_ok=True)
    return d


def cpe_ranges(nvd_cve: dict) -> list[dict]:
    """Plages vulnérables d'une réponse NVD : produit CPE + bornes de version."""
    out = []
    for config in nvd_cve.get("configurations", []):
        for node in config.get("nodes", []):
            for m in node.get("cpeMatch", []):
                if not m.get("vulnerable"):
                    continue
                parts = m.get("criteria", "").split(":")
                if len(parts) < 6:
                    continue
                out.append(
                    {
                        "vendor": parts[3],
                        "product": parts[4],
                        "version": parts[5],
                        **{k: m.get(k) for k in ("versionStartIncluding", "versionStartExcluding", "versionEndIncluding", "versionEndExcluding")},
                    }
                )
    return out


def version_status(installed: str, software_name: str, ranges: list[dict]) -> tuple[str, str | None]:
    """(vulnerable | fixed | unknown, version corrigée si connue) pour le logiciel installé."""
    if not version_tuple(installed):
        return "unknown", None
    name = f" {norm(software_name)} "
    relevant = [r for r in ranges if f" {norm(r['product'].replace('_', ' '))} " in name]
    fixed_in = None
    decided = False
    for r in relevant:
        end_ex, end_in = r.get("versionEndExcluding"), r.get("versionEndIncluding")
        start_in, start_ex = r.get("versionStartIncluding"), r.get("versionStartExcluding")
        if end_ex or end_in:
            decided = True
            above_start = (not start_in or cmp_versions(installed, start_in) >= 0) and (not start_ex or cmp_versions(installed, start_ex) > 0)
            below_end = (end_ex and cmp_versions(installed, end_ex) < 0) or (end_in and cmp_versions(installed, end_in) <= 0)
            if above_start and below_end:
                return "vulnerable", end_ex
            fixed_in = fixed_in or end_ex
        elif r.get("version") not in ("*", "-", ""):
            decided = True
            if cmp_versions(installed, r["version"]) == 0:
                return "vulnerable", None
    return ("fixed", fixed_in) if decided else ("unknown", None)


async def nvd_cve(client: httpx.AsyncClient, cve: str) -> dict | None:
    """Réponse NVD d'une CVE, en cache disque (les plages changent rarement)."""
    if not re.fullmatch(r"CVE-\d{4}-\d{4,7}", cve):
        return None
    cache = _nvd_dir() / f"{cve}.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    res = await client.get(NVD_URL, params={"cveId": cve})
    res.raise_for_status()
    vulns = res.json().get("vulnerabilities", [])
    if not vulns:
        return None
    data = vulns[0].get("cve", {})
    cache.write_text(json.dumps(data), encoding="utf-8")
    await asyncio.sleep(NVD_DELAY)
    return data


# ─────────────────────────────── Windows Update et système
def windows_updates() -> dict:
    """Mises à jour logicielles non installées (recherche seule ; ~1 min)."""
    if sys.platform != "win32":
        return {"available": False, "error": "Windows Update indisponible hors Windows.", "updates": []}
    import pythoncom
    import win32com.client

    def collect() -> list[dict]:
        session = win32com.client.Dispatch("Microsoft.Update.Session")
        session.ClientApplicationID = "DeTecTX (lecture seule)"
        result = session.CreateUpdateSearcher().Search("IsInstalled=0 and Type='Software' and IsHidden=0")
        out = []
        for i in range(result.Updates.Count):
            u = result.Updates.Item(i)
            out.append(
                {
                    "title": str(u.Title),
                    "kbs": [f"KB{u.KBArticleIDs.Item(j)}" for j in range(u.KBArticleIDs.Count)],
                    "cves": [str(u.CveIDs.Item(j)) for j in range(u.CveIDs.Count)],
                    "severity": str(u.MsrcSeverity or "") or None,
                    "categories": [str(u.Categories.Item(j).Name) for j in range(u.Categories.Count)],
                    "reboot": bool(u.RebootRequired),
                }
            )
        return out

    pythoncom.CoInitialize()
    try:
        return {"available": True, "error": None, "updates": collect()}
    except Exception as exc:  # noqa: BLE001 - service Windows Update arrêté, réseau…
        log.warning("Windows Update : recherche impossible (%s)", exc)
        return {"available": False, "error": "Recherche Windows Update impossible (service arrêté ou réseau).", "updates": []}
    finally:
        pythoncom.CoUninitialize()


def os_info() -> dict:
    if sys.platform != "win32":
        return {}
    import winreg

    try:
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")

        def v(name: str) -> str:
            try:
                return str(winreg.QueryValueEx(key, name)[0])
            except OSError:
                return ""

        build = v("CurrentBuild")
        product = v("ProductName")
        if build.isdigit() and int(build) >= 22000:
            product = product.replace("Windows 10", "Windows 11")  # le registre garde « Windows 10 » sur Windows 11
        return {"product": product, "display_version": v("DisplayVersion"), "build": f"{build}.{v('UBR')}" if build else None}
    except OSError:
        return {}


# ─────────────────────────────── analyse complète (tâche de fond)
_report: dict | None = None
_running = False
_lock = asyncio.Lock()


def _report_path() -> Path:
    return Path(settings.intel_dir) / "vulns.json"


def last_report() -> dict | None:
    global _report
    if _report is None:
        try:
            _report = json.loads(_report_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _report = None
    return _report


def is_running() -> bool:
    return _running


async def scan() -> dict:
    """Analyse complète : Windows Update + logiciels × KEV × NVD. Une seule à la fois."""
    global _report, _running
    async with _lock:
        _running = True
        try:
            software, updates = await asyncio.gather(asyncio.to_thread(installed_software), asyncio.to_thread(windows_updates))
            kev = feeds.load_entries("kev")
            pairs = kev_candidates(software, kev)
            findings, checked = [], 0
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0), verify=CA_BUNDLE, headers={"User-Agent": feeds.USER_AGENT}) as client:
                for sw, entry in pairs:
                    status, fixed_in = "unknown", None
                    if checked < MAX_NVD_PER_SCAN:
                        try:
                            data = await nvd_cve(client, entry["cveID"])
                            checked += 1
                            if data:
                                status, fixed_in = version_status(sw["version"], sw["name"], cpe_ranges(data))
                        except Exception as exc:  # noqa: BLE001 - NVD indisponible : verdict « à vérifier »
                            log.warning("NVD %s : %s", entry["cveID"], exc)
                    findings.append({"software": sw, "kev": entry, "status": status, "fixed_in": fixed_in})
            report = {
                "scanned_at": datetime.now(timezone.utc).isoformat(),
                "os": os_info(),
                "windows_update": updates,
                "software_count": len(software),
                "kev_version": feeds.load_state().get("kev", {}).get("updated"),
                "kev_entries": len(kev),
                "findings": findings,
            }
            _report_path().parent.mkdir(parents=True, exist_ok=True)
            _report_path().write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
            _report = report
            return report
        finally:
            _running = False


async def run_forever() -> None:
    """Analyse au démarrage si le dernier rapport a plus de 12 h, puis toutes les 12 h."""
    await asyncio.sleep(60)  # laisse le temps aux listes (KEV) d'être téléchargées au premier démarrage
    while True:
        try:
            report = last_report()
            fresh = report and datetime.now(timezone.utc) - datetime.fromisoformat(report["scanned_at"]) < SCAN_EVERY
            if not fresh:
                await scan()
        except Exception:
            log.exception("analyse des vulnérabilités")
        await asyncio.sleep(SCAN_EVERY.total_seconds() / 12)
