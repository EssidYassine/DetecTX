"""Correspondance locale indicateur <-> listes publiques (sans aucun appel réseau).

IP : ensembles exacts + plages CIDR (recherche par bissection sur les bornes triées) ;
domaine : exact ou domaine parent (un sous-domaine d'un domaine listé correspond) ;
empreinte : ensemble.
"""

import bisect
import ipaddress
from dataclasses import dataclass, field


@dataclass
class FeedIndex:
    ips: dict[str, set[str]] = field(default_factory=dict)  # liste -> IP
    domains: dict[str, set[str]] = field(default_factory=dict)
    hashes: dict[str, set[str]] = field(default_factory=dict)
    _starts: list[int] = field(default_factory=list)  # plages CIDR triées : début, fin, liste
    _ranges: list[tuple[int, int, str]] = field(default_factory=list)

    @classmethod
    def build(cls, feeds: dict[str, tuple[str, list]]) -> "FeedIndex":
        """`feeds` : identifiant -> (type, entrées) ; type = ip | cidr | domain | hash."""
        idx = cls()
        ranges: list[tuple[int, int, str]] = []
        for feed_id, (kind, entries) in feeds.items():
            if kind == "ip":
                idx.ips[feed_id] = set(entries)
            elif kind == "domain":
                idx.domains[feed_id] = {e.lower() for e in entries}
            elif kind == "hash":
                idx.hashes[feed_id] = {e.lower() for e in entries}
            elif kind == "cidr":
                for cidr in entries:
                    try:
                        net = ipaddress.ip_network(cidr, strict=False)
                    except ValueError:
                        continue
                    if net.version == 4:
                        ranges.append((int(net.network_address), int(net.broadcast_address), feed_id))
        ranges.sort()
        idx._ranges = ranges
        idx._starts = [r[0] for r in ranges]
        return idx

    def match(self, itype: str, value: str) -> list[str]:
        """Listes qui connaissent l'indicateur (triées, sans doublon)."""
        found: set[str] = set()
        if itype == "ip":
            found |= {fid for fid, s in self.ips.items() if value in s}
            try:
                ip = ipaddress.ip_address(value)
            except ValueError:
                return sorted(found)
            if ip.version == 4 and self._ranges:
                n = int(ip)
                # Les plages DROP ne se chevauchent pas ; on vérifie tout de même les voisines.
                i = bisect.bisect_right(self._starts, n) - 1
                for start, end, fid in self._ranges[max(0, i - 2) : i + 1]:
                    if start <= n <= end:
                        found.add(fid)
        elif itype == "domain":
            labels = value.lower().split(".")
            candidates = {".".join(labels[k:]) for k in range(len(labels) - 1)}  # a.b.c -> a.b.c, b.c
            found |= {fid for fid, s in self.domains.items() if candidates & s}
        elif itype == "hash":
            found |= {fid for fid, s in self.hashes.items() if value.lower() in s}
        return sorted(found)
