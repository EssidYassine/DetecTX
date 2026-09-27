"""Instantané natif des processus Windows en UN appel système (NtQuerySystemInformation).

Pourquoi : psutil interroge chaque processus séparément et, pour les processus système
(accès refusé), retombe sur une requête système complète... par processus. Mesuré sur le
poste de dev (322 processus, antivirus actif) : ~8 s par énumération. Ici une seule requête
(~10-30 ms) donne pour TOUS les processus : parent, date de création, mémoire, temps CPU,
volume d'E/S et état des threads — c'est ce que fait le Gestionnaire des tâches.

Décodage : structures SYSTEM_PROCESS_INFORMATION / SYSTEM_THREAD_INFORMATION en x64 (les
offsets ci-dessous). Validé contre psutil par tests/test_metrics.py. Python 32 bits ou autre
OS : SUPPORTED = False, l'appelant garde le chemin psutil.
"""

import ctypes
import struct
import sys
from dataclasses import dataclass

SUPPORTED = sys.platform == "win32" and sys.maxsize > 2**32

_SYSTEM_PROCESS_INFORMATION = 5
_STATUS_INFO_LENGTH_MISMATCH = 0xC0000004
_EPOCH_AS_FILETIME = 116_444_736_000_000_000  # 1970-01-01 en unités de 100 ns depuis 1601
_PROC_SIZE = 0x100  # sizeof(SYSTEM_PROCESS_INFORMATION), x64
_THREAD_SIZE = 0x50  # sizeof(SYSTEM_THREAD_INFORMATION), x64
_WAITING = 5  # KTHREAD_STATE.Waiting
_SUSPENDED = 5  # KWAIT_REASON.Suspended


@dataclass(slots=True)
class RawProcess:
    pid: int
    ppid: int
    name: str
    create_time: float | None  # secondes epoch ; None pour les pseudo-processus (Idle, System)
    cpu_seconds: float  # temps CPU cumulé (utilisateur + noyau)
    rss: int  # working set, octets (= rss de psutil sous Windows)
    threads: int
    io_bytes: int  # octets lus + écrits + autres E/S, cumulés
    suspended: bool  # tous les threads suspendus (processus « gelé »)


def _query() -> tuple[ctypes.Array, int]:
    ntdll = ctypes.WinDLL("ntdll")
    fn = ntdll.NtQuerySystemInformation
    fn.argtypes = [ctypes.c_ulong, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]
    fn.restype = ctypes.c_ulong  # NTSTATUS lu non signé pour comparer aux codes 0xC...
    size = 1 << 20
    for _ in range(6):  # la liste peut grossir entre deux essais
        buf = ctypes.create_string_buffer(size)
        needed = ctypes.c_ulong(0)
        status = fn(_SYSTEM_PROCESS_INFORMATION, buf, size, ctypes.byref(needed))
        if status == 0:
            return buf, ctypes.addressof(buf)
        if status != _STATUS_INFO_LENGTH_MISMATCH:
            raise OSError(f"NtQuerySystemInformation a échoué : 0x{status:08X}")
        size = max(size * 2, needed.value + (256 << 10))
    raise OSError("NtQuerySystemInformation : tampon insuffisant")


def snapshot() -> list[RawProcess]:
    buf, base = _query()
    raw = buf.raw
    out: list[RawProcess] = []
    offset = 0
    while True:
        next_offset, nthreads = struct.unpack_from("<II", raw, offset)
        create, user, kernel = struct.unpack_from("<qqq", raw, offset + 32)
        name_len, _, name_ptr = struct.unpack_from("<HH4xQ", raw, offset + 56)
        pid, ppid = struct.unpack_from("<QQ", raw, offset + 80)
        (working_set,) = struct.unpack_from("<Q", raw, offset + 144)
        read, write, other = struct.unpack_from("<qqq", raw, offset + 232)

        # Le nom pointe DANS notre tampon : on le relit depuis la copie, bornes vérifiées.
        name = ""
        rel = name_ptr - base
        if name_ptr and 0 <= rel and rel + name_len <= len(raw):
            name = raw[rel : rel + name_len].decode("utf-16-le", errors="replace")
        elif pid == 0:
            name = "System Idle Process"

        suspended = nthreads > 0
        for t in range(nthreads):
            state, reason = struct.unpack_from("<II", raw, offset + _PROC_SIZE + t * _THREAD_SIZE + 68)
            if state != _WAITING or reason != _SUSPENDED:
                suspended = False
                break

        out.append(
            RawProcess(
                pid=pid,
                ppid=ppid,
                name=name,
                create_time=(create - _EPOCH_AS_FILETIME) / 1e7 if create > 0 else None,
                cpu_seconds=(user + kernel) / 1e7,
                rss=working_set,
                threads=nthreads,
                io_bytes=read + write + other,
                suspended=suspended,
            )
        )
        if next_offset == 0:
            return out
        offset += next_offset
