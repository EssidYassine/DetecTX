"""Assistant « catégorie de réseau » de DeTecTX — script AUTONOME, lancé avec élévation (UAC).

Changer la catégorie d'un réseau (Public <-> Privé) exige les droits administrateur. Le backend
DeTecTX n'en a pas : quand l'administrateur le demande depuis la page Réseau local, le backend
lance CE script via l'invite UAC de Windows ; l'utilisateur confirme dans une boîte de dialogue
du système, hors de portée d'une page web. Le script ne sait faire qu'une chose, et revalide
tout lui-même (il ne fait pas confiance à son appelant) :

    set --name "Maison-5G" --category private|public
        -> passe le réseau CONNECTÉ portant exactement ce nom dans la catégorie demandée.

Refus : nom absent, ambigu (plusieurs réseaux connectés du même nom) ou invalide ; réseau de
DOMAINE (géré par une entreprise : jamais touché) ; catégorie autre que private/public.

Codes de sortie : 0 succès · 2 arguments refusés · 3 réseau introuvable ou ambigu ·
4 pas administrateur · 5 refus de Windows.

Modèle de menace : identique à fw_helper.py (script et interpréteur dans un dossier que seul un
administrateur peut modifier en production ; l'élévation reste soumise au consentement UAC).
"""

import argparse
import re
import sys

CATEGORIES = {"public": 0, "private": 1}  # NLM_NETWORK_CATEGORY ; 2 = domaine, jamais demandé
DOMAIN = 2
NAME_MAX = 255
_FORBIDDEN = re.compile(r'[\x00-\x1f\x7f"]')

EXIT_OK, EXIT_ARGS, EXIT_NOT_FOUND, EXIT_NOT_ADMIN, EXIT_WINDOWS = 0, 2, 3, 4, 5


class Refused(ValueError):
    pass


class NotFound(LookupError):
    pass


def check_name(name: str) -> str:
    if not name or len(name) > NAME_MAX or _FORBIDDEN.search(name):
        raise Refused("nom de réseau invalide")
    return name


def check_category(category: str) -> int:
    if category not in CATEGORIES:
        raise Refused("catégorie invalide (private ou public)")
    return CATEGORIES[category]


def pick(networks: list, name: str):
    """Le réseau connecté portant exactement `name` (objets exposant GetName/GetCategory)."""
    matches = [n for n in networks if n.GetName() == name]
    if not matches:
        raise NotFound("aucun réseau connecté ne porte ce nom")
    if len(matches) > 1:
        raise NotFound("plusieurs réseaux connectés portent ce nom : changement refusé")
    if int(matches[0].GetCategory()) == DOMAIN:
        raise Refused("réseau de domaine (géré par une entreprise) : jamais modifié")
    return matches[0]


def is_admin() -> bool:
    import ctypes

    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


def _connected_networks() -> list:
    import win32com.client

    nlm = win32com.client.Dispatch("{DCB00C01-570F-4A9B-8D69-199FDBA5723B}")  # NetworkListManager
    return list(nlm.GetNetworks(1))  # NLM_ENUM_NETWORK_CONNECTED


def apply(name: str, category: int, networks: list | None = None) -> None:
    network = pick(_connected_networks() if networks is None else networks, name)
    if int(network.GetCategory()) != category:
        network.SetCategory(category)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="netprofile_helper", description="Assistant catégorie de réseau DeTecTX (élevé).")
    sub = parser.add_subparsers(dest="op", required=True)
    s = sub.add_parser("set")
    s.add_argument("--name", required=True)
    s.add_argument("--category", required=True)
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        return EXIT_ARGS
    try:
        name, category = check_name(args.name), check_category(args.category)
    except Refused as e:
        print(f"refusé : {e}", file=sys.stderr)
        return EXIT_ARGS
    if not is_admin():
        print("droits administrateur requis", file=sys.stderr)
        return EXIT_NOT_ADMIN

    import pythoncom

    pythoncom.CoInitialize()
    try:
        apply(name, category)
    except Refused as e:
        print(f"refusé : {e}", file=sys.stderr)
        return EXIT_ARGS
    except NotFound as e:
        print(f"introuvable : {e}", file=sys.stderr)
        return EXIT_NOT_FOUND
    except Exception as e:  # noqa: BLE001 - tout refus de Windows -> code dédié
        print(f"windows : {e}", file=sys.stderr)
        return EXIT_WINDOWS
    finally:
        pythoncom.CoUninitialize()
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
