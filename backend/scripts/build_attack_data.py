"""Génère backend/app/data/attack_enterprise.json à partir des données officielles MITRE ATT&CK.

Usage (une fois, ou pour mettre à jour la version d'ATT&CK) :
    python backend/scripts/build_attack_data.py

Source : dépôt officiel MITRE « attack-stix-data » (bundle STIX 2.1 Enterprise, ~40 Mo), lu en
flux puis jeté ; seul un extrait compact est versionné (techniques Windows non révoquées ni
dépréciées : identifiant, nom, tactiques, première phrase de la description, lien).
Données ATT&CK © The MITRE Corporation, réutilisables selon les conditions d'utilisation d'ATT&CK.
"""

import json
import re
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json"
OUT = Path(__file__).resolve().parents[1] / "app" / "data" / "attack_enterprise.json"
MAX_BYTES = 200 * 1024 * 1024  # garde-fou : le bundle fait ~40 Mo
DESC_MAX = 220

_CITATION = re.compile(r"\(Citation:[^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_CODE = re.compile(r"<code>(.*?)</code>")


def fetch(dest: Path) -> None:
    with urllib.request.urlopen(URL, timeout=180) as res, dest.open("wb") as f:
        total = 0
        while chunk := res.read(1 << 20):
            total += len(chunk)
            if total > MAX_BYTES:
                raise SystemExit("Téléchargement anormalement volumineux : abandon.")
            f.write(chunk)
    print(f"téléchargé : {total / 1e6:.1f} Mo")


def first_sentence(text: str) -> str:
    text = _CODE.sub(r"\1", _LINK.sub(r"\1", _CITATION.sub("", text or "")))
    text = " ".join(text.split())
    end = text.find(". ")
    sentence = text[: end + 1] if 0 < end < DESC_MAX else text
    return sentence if len(sentence) <= DESC_MAX else sentence[: DESC_MAX - 1].rstrip() + "…"


def extract(bundle: dict) -> dict:
    if bundle.get("type") != "bundle" or not isinstance(bundle.get("objects"), list):
        raise SystemExit("Fichier inattendu : ce n'est pas un bundle STIX.")
    objects = bundle["objects"]
    alive = [o for o in objects if not o.get("revoked") and not o.get("x_mitre_deprecated")]

    collection = next((o for o in objects if o.get("type") == "x-mitre-collection"), {})
    tactic_by_ref = {o["id"]: o for o in alive if o.get("type") == "x-mitre-tactic"}
    matrix = next((o for o in alive if o.get("type") == "x-mitre-matrix"), {})
    tactics = [
        {"id": t["x_mitre_shortname"], "name": t["name"]}
        for ref in matrix.get("tactic_refs", [])
        if (t := tactic_by_ref.get(ref))
    ]

    techniques = {}
    for o in alive:
        if o.get("type") != "attack-pattern" or "Windows" not in o.get("x_mitre_platforms", []):
            continue
        ref = next((r for r in o.get("external_references", []) if r.get("source_name") == "mitre-attack"), None)
        if not ref or not re.fullmatch(r"T\d{4}(\.\d{3})?", ref.get("external_id", "")):
            continue
        techniques[ref["external_id"]] = {
            "name": o["name"],
            "tactics": [p["phase_name"] for p in o.get("kill_chain_phases", []) if p.get("kill_chain_name") == "mitre-attack"],
            "desc": first_sentence(o.get("description", "")),
            "url": ref.get("url"),
        }
    # Nom complet des sous-techniques : « Parent: Sous-technique » (comme sur attack.mitre.org).
    for tid, t in techniques.items():
        parent = techniques.get(tid.split(".")[0])
        if "." in tid and parent and not t["name"].startswith(parent["name"]):
            t["name"] = f"{parent['name']}: {t['name']}"

    return {
        "source": URL,
        "attack_version": collection.get("x_mitre_version"),
        "generated": datetime.now(timezone.utc).date().isoformat(),
        "tactics": tactics,
        "techniques": dict(sorted(techniques.items())),
    }


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "enterprise-attack.json"
        fetch(raw)
        data = extract(json.loads(raw.read_text(encoding="utf-8")))
    # le bundle de 40 Mo disparaît avec le dossier temporaire
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"ATT&CK {data['attack_version']} : {len(data['tactics'])} tactiques, {len(data['techniques'])} techniques -> {OUT} ({OUT.stat().st_size / 1024:.0f} Ko)")


if __name__ == "__main__":
    sys.exit(main())
