"""Assistant pare-feu privilégié de DeTecTX — script AUTONOME, lancé avec élévation (UAC).

Le backend DeTecTX tourne sans droits administrateur. Quand l'utilisateur demande de bloquer
un port, le backend lance CE script via l'invite UAC de Windows : l'utilisateur confirme dans
une boîte de dialogue du système, hors de portée d'une page web. Le script ne sait faire que
deux choses, et revalide tout lui-même (il ne fait pas confiance à son appelant) :

    block   --targets tcp:445,udp:137 --profiles public[,private,domain]
            -> une règle entrante « Bloquer » par port, dans le groupe « DeTecTX »
    unblock --name "DeTecTX - bloque TCP 445 (public)"
            -> supprime cette règle, SEULEMENT si elle appartient au groupe DeTecTX

Il ne modifie ni ne supprime jamais une règle existante de l'utilisateur ou de Windows : un
blocage l'emporte sur les autorisations, il suffit donc d'en ajouter.

Codes de sortie : 0 succès · 2 arguments refusés · 3 erreur du pare-feu · 4 pas administrateur.

Modèle de menace : le script et l'interpréteur doivent être dans un dossier que seul un
administrateur peut modifier (installation dans Program Files en production). En dev, dans
un dossier utilisateur, un programme malveillant déjà actif pourrait le modifier — mais il
pourrait tout aussi bien afficher sa propre invite UAC : l'élévation reste soumise au
consentement de l'utilisateur.
"""

import argparse
import re
import sys
from datetime import datetime

GROUP = "DeTecTX"
PROFILE_BITS = {"domain": 1, "private": 2, "public": 4}
PROTOCOLS = {"tcp": 6, "udp": 17}
MAX_PORTS = 20
NAME_RE = re.compile(r"^DeTecTX - bloque (TCP|UDP) (\d{1,5}) \(((?:domain|private|public)(?:\+(?:domain|private|public)){0,2})\)$")

EXIT_OK, EXIT_ARGS, EXIT_FIREWALL, EXIT_NOT_ADMIN = 0, 2, 3, 4


class Refused(ValueError):
    pass


def parse_targets(raw: str) -> list[tuple[str, int]]:
    """« tcp:445,udp:137 » -> [("tcp", 445), ("udp", 137)] ; dédoublonné, 1 à 20 cibles."""
    targets: list[tuple[str, int]] = []
    for token in raw.split(","):
        proto, _, port = token.strip().partition(":")
        if proto not in PROTOCOLS or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise Refused(f"cible invalide : {token.strip()!r}")
        if (proto, int(port)) not in targets:
            targets.append((proto, int(port)))
    if not 1 <= len(targets) <= MAX_PORTS:
        raise Refused("entre 1 et 20 ports")
    return targets


def format_targets(targets: list[tuple[str, int]]) -> str:
    return ",".join(f"{proto}:{port}" for proto, port in targets)


def parse_profiles(raw: str) -> list[str]:
    profiles = []
    for token in raw.split(","):
        token = token.strip().lower()
        if token not in PROFILE_BITS:
            raise Refused(f"profil invalide : {token!r}")
        if token not in profiles:
            profiles.append(token)
    if not profiles:
        raise Refused("au moins un profil")
    return sorted(profiles, key=list(PROFILE_BITS).index)


def rule_name(proto: str, port: int, profiles: list[str]) -> str:
    return f"DeTecTX - bloque {proto.upper()} {port} ({'+'.join(profiles)})"


def is_admin() -> bool:
    import ctypes

    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


def _policy():
    import win32com.client

    return win32com.client.Dispatch("HNetCfg.FwPolicy2")


def block(targets: list[tuple[str, int]], profiles: list[str]) -> None:
    import win32com.client

    policy = _policy()
    existing = {r.Name for r in policy.Rules if (r.Grouping or "") == GROUP}
    mask = sum(PROFILE_BITS[p] for p in profiles)
    for proto, port in targets:
        name = rule_name(proto, port, profiles)
        if name in existing:
            continue  # idempotent : déjà bloqué par DeTecTX
        rule = win32com.client.Dispatch("HNetCfg.FWRule")
        rule.Name = name
        rule.Description = (
            f"Ajoutée par DeTecTX le {datetime.now().astimezone():%d/%m/%Y %H:%M}. "
            "À retirer depuis DeTecTX (Système > Ports & pare-feu) ou depuis cette console."
        )
        rule.Grouping = GROUP
        rule.Protocol = PROTOCOLS[proto]
        rule.LocalPorts = str(port)
        rule.Direction = 1  # entrant
        rule.Action = 0  # bloquer
        rule.Profiles = mask
        rule.Enabled = True
        policy.Rules.Add(rule)


def unblock(name: str) -> None:
    if not NAME_RE.match(name):
        raise Refused("nom de règle non conforme au format DeTecTX")
    policy = _policy()
    matches = [r for r in policy.Rules if r.Name == name]
    if not matches:
        return  # déjà retirée : idempotent
    if any((r.Grouping or "") != GROUP for r in matches):
        raise Refused("cette règle n'appartient pas à DeTecTX : refus de la supprimer")
    policy.Rules.Remove(name)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fw_helper", description="Assistant pare-feu DeTecTX (élevé).")
    sub = parser.add_subparsers(dest="op", required=True)
    b = sub.add_parser("block")
    b.add_argument("--targets", required=True)
    b.add_argument("--profiles", required=True)
    u = sub.add_parser("unblock")
    u.add_argument("--name", required=True)
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        return EXIT_ARGS

    try:
        if args.op == "block":
            targets, profiles = parse_targets(args.targets), parse_profiles(args.profiles)
        elif not NAME_RE.match(args.name):
            raise Refused("nom de règle non conforme au format DeTecTX")
    except Refused as e:
        print(f"refusé : {e}", file=sys.stderr)
        return EXIT_ARGS

    if not is_admin():
        print("droits administrateur requis", file=sys.stderr)
        return EXIT_NOT_ADMIN
    try:
        if args.op == "block":
            block(targets, profiles)
        else:
            unblock(args.name)
    except Refused as e:
        print(f"refusé : {e}", file=sys.stderr)
        return EXIT_ARGS
    except Exception as e:  # noqa: BLE001 - tout échec du pare-feu -> code dédié
        print(f"pare-feu : {e}", file=sys.stderr)
        return EXIT_FIREWALL
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
