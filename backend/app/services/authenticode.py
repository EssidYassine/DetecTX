"""Signature Authenticode des exécutables (qui a signé ce binaire ?), sans droits admin.

Windows signe la plupart de ses propres binaires PAR CATALOGUE (le fichier lui-même ne porte
aucune signature : `notepad.exe` répond « non signé » à une vérification naïve). On vérifie donc
d'abord la signature intégrée, puis, si elle est absente, les catalogues du système
(`CryptCATAdmin*`) — sans quoi chaque binaire Windows serait un faux positif.

Aucun appel réseau : révocation non vérifiée en ligne (`WTD_REVOKE_NONE` + cache d'URL seul).
Une vérification qui échoue donne `unknown`, jamais `unsigned` : on ne crie pas au loup.
Coût mesuré : ~13 ms par fichier ; résultats mis en cache par (chemin, taille, date).
"""

from __future__ import annotations

import logging
import os
import re
import sys
import threading
from dataclasses import asdict, dataclass
from typing import Literal

log = logging.getLogger("detectx.authenticode")

SUPPORTED = sys.platform == "win32"
Verdict = Literal["microsoft", "signed", "unsigned", "invalid", "unknown"]

# Codes WinVerifyTrust (HRESULT, non signés).
_OK = 0
_NO_SIGNATURE = {0x800B0100, 0x800B0003, 0x800B0001}  # pas de signature / format sans signature possible
_INVALID = {
    0x80096010,  # TRUST_E_BAD_DIGEST : fichier modifié après signature
    0x800B010C,  # CERT_E_REVOKED
    0x800B0111,  # TRUST_E_EXPLICIT_DISTRUST
    0x800B0109,  # CERT_E_UNTRUSTEDROOT : racine inconnue (auto-signé)
    0x800B010A,  # CERT_E_CHAINING
    0x80096019,  # TRUST_E_CERT_SIGNATURE
    0x80092026,  # CRYPT_E_SECURITY_SETTINGS : bloqué par stratégie
}
_EXPIRED = 0x800B0101  # certificat expiré SANS horodatage : l'éditeur reste identifiable

_MS_PUBLISHERS = ("microsoft windows", "microsoft corporation", "microsoft windows publisher", "microsoft windows hardware compatibility publisher")


@dataclass(frozen=True)
class Signature:
    verdict: Verdict
    publisher: str | None = None
    via_catalog: bool = False
    detail: str | None = None

    def as_dict(self) -> dict:
        return asdict(self)


UNKNOWN = Signature("unknown")
MISSING = Signature("unknown", detail="fichier introuvable")


def classify(code: int | None, publisher: str | None, *, via_catalog: bool = False) -> Signature:
    """Code WinVerifyTrust (+ éditeur lu) → verdict. Pur : testé sans Windows."""
    if code is None:
        return UNKNOWN
    code &= 0xFFFFFFFF
    if code in (_OK, _EXPIRED):
        name = (publisher or "").strip() or None
        verdict: Verdict = "microsoft" if name and name.lower() in _MS_PUBLISHERS else "signed"
        detail = "certificat expiré (non horodaté)" if code == _EXPIRED else None
        return Signature(verdict, name, via_catalog, detail)
    if code in _NO_SIGNATURE:
        return Signature("unsigned")
    if code in _INVALID:
        return Signature("invalid", publisher, via_catalog, f"signature rejetée (0x{code:08X})")
    return Signature("unknown", None, via_catalog, f"vérification impossible (0x{code:08X})")


# Applications du Store (MSIX) : c'est le PAQUET qui est signé (AppxSignature.p7x), pas chaque
# fichier. Leurs dossiers ne sont modifiables que par TrustedInstaller ; l'éditeur se lit dans
# le manifeste du paquet (attribut Publisher="CN=…").
_PACKAGE_ROOTS = tuple(
    os.path.normcase(os.path.join(os.environ.get(var, default), sub)) + os.sep
    for var, default, sub in (("ProgramFiles", r"C:\Program Files", "WindowsApps"), ("SystemRoot", r"C:\Windows", "SystemApps"))
)
_MANIFEST_PUBLISHER = re.compile(r"<Identity\b[^>]*?\bPublisher\s*=\s*\"([^\"]{1,512})\"", re.DOTALL)
_MANIFEST_DISPLAY = re.compile(r"<PublisherDisplayName>\s*([^<]{1,200}?)\s*</PublisherDisplayName>")
_GUID_NAME = re.compile(r"^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$")


def publisher_from_manifest(xml: str) -> str | None:
    """`Publisher="CN=Microsoft Corporation, O=…"` → « Microsoft Corporation ». Les paquets signés
    par le Store ont un CN en GUID : on prend alors le nom affiché de l'éditeur. Pur, testé."""
    m = _MANIFEST_PUBLISHER.search(xml)
    if not m:
        return None
    cn = re.search(r"(?:^|,)\s*CN=([^,]+)", m.group(1))
    name = cn.group(1).strip() if cn else None
    if name and _GUID_NAME.match(name):
        display = _MANIFEST_DISPLAY.search(xml)
        if display and not display.group(1).startswith("ms-resource:"):
            return display.group(1)
    return name


def _packaged(path: str) -> Signature | None:
    norm = os.path.normcase(os.path.abspath(path))
    root = next((r for r in _PACKAGE_ROOTS if norm.startswith(r)), None)
    if root is None:
        return None
    package = norm[len(root):].split(os.sep, 1)[0]
    manifest = os.path.join(root, package, "AppxManifest.xml")
    try:
        with open(manifest, encoding="utf-8", errors="replace") as f:
            publisher = publisher_from_manifest(f.read(64_000))
    except OSError:
        return None
    if not publisher:
        return None
    verdict: Verdict = "microsoft" if publisher.lower() in _MS_PUBLISHERS else "signed"
    return Signature(verdict, publisher, False, "application du Store (paquet signé)")


# ─────────────────────────────── cache
_cache: dict[tuple, Signature] = {}
_cache_lock = threading.Lock()
_MAX_CACHE = 6000


def _key(path: str) -> tuple | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (os.path.normcase(path), st.st_size, st.st_mtime_ns)


def cached(path: str | None) -> Signature | None:
    """Verdict déjà calculé (non bloquant), None s'il reste à calculer."""
    if not path:
        return None
    key = _key(path)
    if key is None:
        return MISSING
    with _cache_lock:
        return _cache.get(key)


def verify(path: str | None) -> Signature:
    """Verdict de signature d'un fichier (bloquant, ~13 ms ; mis en cache)."""
    if not path or not SUPPORTED:
        return UNKNOWN
    key = _key(path)
    if key is None:
        return MISSING
    with _cache_lock:
        hit = _cache.get(key)
    if hit is not None:
        return hit
    try:
        sig = _win_verify(path)
        if sig.verdict == "unsigned":
            sig = _packaged(path) or sig
    except Exception:
        log.debug("vérification de signature impossible : %s", path, exc_info=True)
        sig = UNKNOWN
    with _cache_lock:
        if len(_cache) >= _MAX_CACHE:
            _cache.clear()
        _cache[key] = sig
    return sig


# Calcul en tâche de fond : les listes (processus, persistance) ne bloquent jamais dessus.
_pending: set[str] = set()
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()
MAX_PER_PASS = 1000  # ~700 fichiers distincts sur un poste courant (pilotes compris), ~15 ms chacun


def schedule(paths) -> None:
    """Demande la vérification de chemins en arrière-plan (sans attendre)."""
    global _worker
    if not SUPPORTED:
        return
    todo = {p for p in paths if p and cached(p) is None}
    if not todo:
        return
    with _worker_lock:
        _pending.update(todo)
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_drain, name="detectx-authenticode", daemon=True)
            _worker.start()


def wait_idle(timeout: float = 30.0) -> bool:
    """Attend la fin des vérifications en arrière-plan (tests : nombre de threads stable)."""
    worker = _worker
    if worker is not None:
        worker.join(timeout)
        return not worker.is_alive()
    return True


def _drain() -> None:
    done = 0
    while done < MAX_PER_PASS:
        with _worker_lock:
            if not _pending:
                return
            path = _pending.pop()
        verify(path)
        done += 1
    with _worker_lock:
        _pending.clear()  # plafond atteint : le reste sera redemandé au prochain relevé


# ─────────────────────────────── Windows (ctypes)
if SUPPORTED:
    import ctypes
    from ctypes import wintypes

    _wintrust = ctypes.WinDLL("wintrust", use_last_error=True)
    _crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _GUID(ctypes.Structure):
        _fields_ = [("a", wintypes.DWORD), ("b", wintypes.WORD), ("c", wintypes.WORD), ("d", ctypes.c_ubyte * 8)]

    def _guid(a, b, c, *d) -> _GUID:
        return _GUID(a, b, c, (ctypes.c_ubyte * 8)(*d))

    _GENERIC_VERIFY_V2 = _guid(0xAAC56B, 0xCD44, 0x11D0, 0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE)
    _DRIVER_ACTION_VERIFY = _guid(0xF750E6C3, 0x38EE, 0x11D1, 0x85, 0xE5, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE)

    class _FILE_INFO(ctypes.Structure):
        _fields_ = [
            ("cbStruct", wintypes.DWORD),
            ("pcwszFilePath", wintypes.LPCWSTR),
            ("hFile", wintypes.HANDLE),
            ("pgKnownSubject", ctypes.c_void_p),
        ]

    class _CATALOG_INFO(ctypes.Structure):  # WINTRUST_CATALOG_INFO
        _fields_ = [
            ("cbStruct", wintypes.DWORD),
            ("dwCatalogVersion", wintypes.DWORD),
            ("pcwszCatalogFilePath", wintypes.LPCWSTR),
            ("pcwszMemberTag", wintypes.LPCWSTR),
            ("pcwszMemberFilePath", wintypes.LPCWSTR),
            ("hMemberFile", wintypes.HANDLE),
            ("pbCalculatedFileHash", ctypes.c_void_p),
            ("cbCalculatedFileHash", wintypes.DWORD),
            ("pcCatalogContext", ctypes.c_void_p),
            ("hCatAdmin", wintypes.HANDLE),
        ]

    class _TRUST_DATA(ctypes.Structure):  # WINTRUST_DATA
        _fields_ = [
            ("cbStruct", wintypes.DWORD),
            ("pPolicyCallbackData", ctypes.c_void_p),
            ("pSIPClientData", ctypes.c_void_p),
            ("dwUIChoice", wintypes.DWORD),
            ("fdwRevocationChecks", wintypes.DWORD),
            ("dwUnionChoice", wintypes.DWORD),
            ("pInfo", ctypes.c_void_p),
            ("dwStateAction", wintypes.DWORD),
            ("hWVTStateData", wintypes.HANDLE),
            ("pwszURLReference", wintypes.LPCWSTR),
            ("dwProvFlags", wintypes.DWORD),
            ("dwUIContext", wintypes.DWORD),
            ("pSignatureSettings", ctypes.c_void_p),
        ]

    class _CAT_INFO(ctypes.Structure):  # CATALOG_INFO
        _fields_ = [("cbStruct", wintypes.DWORD), ("wszCatalogFile", wintypes.WCHAR * 260)]

    _WTD_UI_NONE = 2
    _WTD_REVOKE_NONE = 0
    _WTD_CHOICE_FILE = 1
    _WTD_CHOICE_CATALOG = 2
    _WTD_STATEACTION_VERIFY = 1
    _WTD_STATEACTION_CLOSE = 2
    _WTD_REVOCATION_CHECK_NONE = 0x10
    _WTD_CACHE_ONLY_URL_RETRIEVAL = 0x1000
    _INVALID_HANDLE = wintypes.HANDLE(-1).value

    _wintrust.WinVerifyTrust.argtypes = [wintypes.HWND, ctypes.POINTER(_GUID), ctypes.c_void_p]
    _wintrust.WinVerifyTrust.restype = ctypes.c_long
    _wintrust.WTHelperProvDataFromStateData.argtypes = [wintypes.HANDLE]
    _wintrust.WTHelperProvDataFromStateData.restype = ctypes.c_void_p
    _wintrust.WTHelperGetProvSignerFromChain.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _wintrust.WTHelperGetProvSignerFromChain.restype = ctypes.c_void_p
    _wintrust.WTHelperGetProvCertFromChain.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    _wintrust.WTHelperGetProvCertFromChain.restype = ctypes.c_void_p
    _wintrust.CryptCATAdminAcquireContext2.argtypes = [ctypes.POINTER(wintypes.HANDLE), ctypes.POINTER(_GUID), wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD]
    _wintrust.CryptCATAdminReleaseContext.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    _wintrust.CryptCATAdminCalcHashFromFileHandle2.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p, wintypes.DWORD]
    _wintrust.CryptCATAdminEnumCatalogFromHash.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    _wintrust.CryptCATAdminEnumCatalogFromHash.restype = wintypes.HANDLE
    _wintrust.CryptCATAdminReleaseCatalogContext.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.DWORD]
    _wintrust.CryptCATCatalogInfoFromContext.argtypes = [wintypes.HANDLE, ctypes.POINTER(_CAT_INFO), wintypes.DWORD]
    _crypt32.CertGetNameStringW.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.LPWSTR, wintypes.DWORD]
    _crypt32.CertGetNameStringW.restype = wintypes.DWORD
    _kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _kernel32.CreateFileW.restype = wintypes.HANDLE
    _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    def _publisher(state: int) -> str | None:
        """Nom du signataire (ex. « Microsoft Windows ») depuis l'état conservé par WinVerifyTrust."""
        prov = _wintrust.WTHelperProvDataFromStateData(state)
        if not prov:
            return None
        signer = _wintrust.WTHelperGetProvSignerFromChain(prov, 0, False, 0)
        if not signer:
            return None
        cert = _wintrust.WTHelperGetProvCertFromChain(signer, 0)
        if not cert:
            return None
        # CRYPT_PROVIDER_CERT : { DWORD cbStruct; PCCERT_CONTEXT pCert; … } (pointeur aligné sur 8).
        context = ctypes.c_void_p.from_address(cert + ctypes.sizeof(ctypes.c_void_p)).value
        if not context:
            return None
        buf = ctypes.create_unicode_buffer(256)
        n = _crypt32.CertGetNameStringW(context, 4, 0, None, buf, len(buf))  # CERT_NAME_SIMPLE_DISPLAY_TYPE
        return buf.value if n > 1 else None

    def _trust(choice: int, info, action: _GUID) -> tuple[int, str | None]:
        data = _TRUST_DATA(
            ctypes.sizeof(_TRUST_DATA), None, None, _WTD_UI_NONE, _WTD_REVOKE_NONE, choice,
            ctypes.cast(ctypes.pointer(info), ctypes.c_void_p), _WTD_STATEACTION_VERIFY, None, None,
            _WTD_REVOCATION_CHECK_NONE | _WTD_CACHE_ONLY_URL_RETRIEVAL, 0, None,
        )
        code = _wintrust.WinVerifyTrust(None, ctypes.byref(action), ctypes.byref(data)) & 0xFFFFFFFF
        try:
            publisher = _publisher(data.hWVTStateData) if code in (_OK, _EXPIRED) or code in _INVALID else None
        finally:
            data.dwStateAction = _WTD_STATEACTION_CLOSE
            _wintrust.WinVerifyTrust(None, ctypes.byref(action), ctypes.byref(data))
        return code, publisher

    def _catalog(path: str) -> tuple[int, str | None] | None:
        """Vérifie le fichier par les catalogues du système ; None s'il n'y figure pas."""
        handle = _kernel32.CreateFileW(path, 0x80000000, 0x1 | 0x4, None, 3, 0, None)  # lecture, partage lecture+suppression
        if handle in (None, _INVALID_HANDLE):
            return None
        try:
            for algorithm in ("SHA256", None):  # catalogues récents (SHA-256) puis anciens (SHA-1)
                admin = wintypes.HANDLE()
                if not _wintrust.CryptCATAdminAcquireContext2(ctypes.byref(admin), ctypes.byref(_DRIVER_ACTION_VERIFY), algorithm, None, 0):
                    continue
                try:
                    size = wintypes.DWORD(0)
                    _wintrust.CryptCATAdminCalcHashFromFileHandle2(admin, handle, ctypes.byref(size), None, 0)
                    if not size.value or size.value > 64:
                        continue
                    digest = (ctypes.c_ubyte * size.value)()
                    if not _wintrust.CryptCATAdminCalcHashFromFileHandle2(admin, handle, ctypes.byref(size), digest, 0):
                        continue
                    context = _wintrust.CryptCATAdminEnumCatalogFromHash(admin, digest, size.value, 0, None)
                    if not context:
                        continue
                    try:
                        cat = _CAT_INFO(ctypes.sizeof(_CAT_INFO))
                        if not _wintrust.CryptCATCatalogInfoFromContext(context, ctypes.byref(cat), 0):
                            continue
                        tag = bytes(digest).hex().upper()
                        info = _CATALOG_INFO(
                            ctypes.sizeof(_CATALOG_INFO), 0, cat.wszCatalogFile, tag, path, None,
                            ctypes.cast(digest, ctypes.c_void_p), size.value, None, admin,
                        )
                        return _trust(_WTD_CHOICE_CATALOG, info, _GENERIC_VERIFY_V2)
                    finally:
                        _wintrust.CryptCATAdminReleaseCatalogContext(admin, context, 0)
                finally:
                    _wintrust.CryptCATAdminReleaseContext(admin, 0)
            return None
        finally:
            _kernel32.CloseHandle(handle)

    def _win_verify(path: str) -> Signature:
        info = _FILE_INFO(ctypes.sizeof(_FILE_INFO), path, None, None)
        code, publisher = _trust(_WTD_CHOICE_FILE, info, _GENERIC_VERIFY_V2)
        if code in _NO_SIGNATURE:
            found = _catalog(path)
            if found is not None:
                return classify(found[0], found[1], via_catalog=True)
        return classify(code, publisher)

else:  # pragma: no cover - hors Windows : aucune signature Authenticode à lire

    def _win_verify(path: str) -> Signature:
        return UNKNOWN
