# Plan — « L'Atelier » : Nmap facile + profils personnalisés

> Statut : **proposé**, rien n'est implémenté. Rédigé le 2026-10-02.
> Suite de [`reseau-nmap-sonar.md`](reseau-nmap-sonar.md) (étapes 1 à 5 livrées, commits `b4271c2` → `de2304b`).

## 1. Contexte et objectif

Le Sonar sait déjà **qui** est sur le réseau et **quels ports** sont ouverts. Il manque le **comment** : pouvoir dire « analyse cet appareil, comme ceci » sans connaître Nmap, et pouvoir aller plus loin quand on le veut.

Deux besoins, exprimés par l'utilisateur :
1. **Nmap facile** — des objectifs en français, dans la fiche de chaque appareil, avec la durée annoncée. Pour l'usage courant.
2. **Profils personnalisés** — composer soi-même ses options Nmap, les enregistrer sous un nom, et les appliquer à une cible choisie. Pour aller plus loin, et pour apprendre Nmap.

Le tout rassemblé dans un écran : **« L'Atelier »**, troisième onglet de la page Réseau local.

### La question centrale : champ libre ou catalogue ?

L'utilisateur a demandé « j'ajoute les options nécessaires, même si elles sont nombreuses ». Deux façons de le faire :

| | Champ de texte libre | **Catalogue d'options (retenu)** |
|---|---|---|
| Liberté | totale | large : toutes les options utiles d'inventaire |
| Ce qui atteint la ligne de commande | ce que l'utilisateur tape | des identifiants reconnus par le serveur |
| Injection de commande | possible si la validation a un trou | **impossible par construction** |
| Apprentissage | il faut déjà connaître Nmap | chaque option est expliquée en français |
| Audit OWASP du mémoire | difficile à défendre | défendable en une phrase |

**Décision : catalogue.** Le frontend envoie des **identifiants d'options** (`syn-scan`, `version-light`, `timing-t4`…) et, pour les rares options paramétrées, une **valeur strictement typée** (une plage de ports, un entier borné). Le backend reconstruit `argv` **uniquement** à partir de son propre catalogue : aucune chaîne venue du navigateur n'est jamais concaténée dans la ligne de commande.

La liberté reste réelle : ~40 options couvrant tout l'inventaire réseau, combinables librement, avec aperçu en direct de la commande. Ce qui est exclu l'est pour une raison, affichée dans l'interface (voir §4.3).

## 2. Architecture

```
                        ┌──────────── L'Atelier (onglet) ─────────────┐
  Objectifs             │  4 cartes : « Que fait cet appareil ? »…    │
  (presets maison)      │  → profil figé, durée annoncée              │
                        │                                             │
  Profils personnalisés │  Constructeur visuel : catalogue d'options  │
  (créés par vous)      │  cochées → aperçu de la commande en direct  │
                        │  → enregistré en base (net_scan_profiles)   │
                        └───────────────────┬─────────────────────────┘
                                            │ POST /network/scan
                                            │   { profile: "custom", profile_id: 7, device_id }
                                            ▼
                        ┌─────────── backend/app/network ─────────────┐
                        │ options.py  CATALOGUE (id → flags, règles)  │
                        │ target.py   build_argv() ← SEULE source     │
                        │             de la ligne de commande         │
                        │ nmap_runner.py  exécution, XML defusedxml   │
                        └───────────────────┬─────────────────────────┘
                                            ▼
                             fiche enrichie + historique des changements
```

## 3. Les objectifs (usage courant)

Dans la fiche d'un appareil, quatre cartes. Chacune est un profil **figé** du catalogue, décrit en français, avec sa durée mesurée.

| Carte | Question posée | Options | Durée |
|---|---|---|---|
| **Que fait cet appareil ?** | ses services et leurs versions | `-sS -sV --version-light -O --osscan-limit --top-ports 1000` | ~1 min |
| **L'identifier précisément** | son nom, son modèle, sa page web | `-sS -sV --script <identification>` (voir §4.4) | ~30 s |
| **Tout examiner** | aucun port oublié | `-sS -p- -T4` | 5–10 min |
| **Services UDP** | DNS, SNMP, UPnP… | `-sU --top-ports 50 -sV --version-light` | 2–5 min |

Plus un bouton pour **tout le réseau** : **« Écouter le voisinage »** (~20 s). Il recueille ce que les appareils annoncent déjà d'eux-mêmes (mDNS, UPnP, NetBIOS) : noms et modèles des TV, imprimantes, enceintes. Aucun port n'est sondé, c'est de l'écoute.

## 4. Les profils personnalisés

### 4.1 Le constructeur visuel

Trois colonnes :

```
┌─ Catalogue d'options ────────┬─ Votre profil ──────────┬─ Aperçu ────────────┐
│ ▸ Type de scan          (6)  │  Nom  [Audit maison   ] │ nmap -sS -sV -O     │
│ ▸ Découverte d'hôtes    (7)  │                         │   --version-all     │
│ ▸ Ports et plages       (5)  │  ☑ Scan SYN             │   -p 1-1024,8080    │
│ ▸ Détection de services (6)  │  ☑ Versions (complet)   │   -T4 --open        │
│ ▸ Système d'exploitation(3)  │  ☑ Système              │                     │
│ ▸ Scripts d'identification(8)│  ☑ Ports [1-1024,8080]  │ Durée estimée       │
│ ▸ Rythme et performance (6)  │  ☑ Rythme T4            │   ~2 min / appareil │
│ ▸ Affichage             (4)  │  ☑ Ports ouverts seuls  │                     │
│                              │                         │ ⚠ -O exige Npcap    │
│ [chaque option : nom FR,     │  [Enregistrer] [Tester] │                     │
│  le flag, 1 phrase « ce que  │                         │                     │
│  ça fait », « ce que ça      │                         │                     │
│  coûte en temps »]           │                         │                     │
└──────────────────────────────┴─────────────────────────┴─────────────────────┘
```

- **Aperçu en direct** : la commande exacte, telle qu'elle sera lancée. C'est aussi ce qui fait apprendre Nmap.
- **Incompatibilités signalées** : `-sS` et `-sT` ensemble, `-p-` avec `--top-ports`, `-O` sans paquets bruts… L'interface le dit avant d'enregistrer.
- **Durée estimée** : calculée à partir des options (nombre de ports × rythme × détection de version). Un ordre de grandeur, annoncé comme tel.
- **Tester** : lance le profil sur **un** appareil choisi, sans l'enregistrer.

### 4.2 Le catalogue (≈ 40 options)

| Groupe | Exemples d'options |
|---|---|
| Type de scan | SYN (`-sS`), connexion (`-sT`), UDP (`-sU`), ACK (`-sA`), fenêtre (`-sW`), ping seul (`-sn`) |
| Découverte d'hôtes | pas de ping (`-Pn`), ping TCP SYN/ACK (`-PS`/`-PA`), ICMP (`-PE`), ARP (`-PR`), pas de DNS (`-n`), DNS forcé (`-R`) |
| Ports et plages | tous (`-p-`), plage libre (`-p <valeur validée>`), N plus courants (`--top-ports N`), exclure (`--exclude-ports`), ordre aléatoire (`-r`) |
| Détection de services | versions (`-sV`), intensité légère/normale/complète (`--version-light`, `--version-all`), bannières (`--script banner`) |
| Système | détection (`-O`), limiter aux hôtes prometteurs (`--osscan-limit`), deviner (`--osscan-guess`) |
| Scripts d'identification | voir §4.4 — **uniquement** la catégorie `safe` |
| Rythme et performance | `-T0` à `-T5`, `--max-retries`, `--host-timeout`, `--min-rate`, `--max-rate` |
| Affichage | ports ouverts seuls (`--open`), détaillé (`-v`), motifs de l'état (`--reason`), traceroute (`--traceroute`) |

Chaque entrée du catalogue porte : identifiant, libellé français, flag Nmap, explication en une phrase, coût en temps, et éventuellement un paramètre typé.

### 4.3 Ce qui n'est pas dans le catalogue, et pourquoi

L'interface affiche la raison, elle ne se contente pas de masquer :

| Exclu | Raison |
|---|---|
| Scripts `brute`, `exploit`, `dos`, `intrusive`, `vuln` | Ils attaquent au lieu d'inventorier : force brute de mots de passe, tentatives d'exploitation, déni de service. Hors du périmètre de DeTecTX (dit « l'IA recommande, l'humain agit », et ici : « on observe, on n'agresse pas »). |
| `--script-args`, `--datadir`, `-iL`, `-oA`, `--resume` | Permettent de lire ou d'écrire des fichiers arbitraires, ou de charger un script hors catalogue. |
| Leurres et usurpation (`-D`, `-S`, `--spoof-mac`) | Servent à masquer l'origine d'un scan. Un outil défensif n'a pas à les proposer. |
| Fragmentation et évasion (`-f`, `--mtu`, `--data-length`) | Servent à contourner un pare-feu ou un IDS. Même raison. |
| `-T0`/`-T1` sur tout un sous-réseau | Un scan furtif de /24 dure des heures : plafonné (voir §4.5). |

Ces exclusions **ne limitent pas** l'inventaire d'un réseau domestique : tout ce qui sert à savoir « quel appareil, quel service, quelle version » reste disponible.

### 4.4 Scripts d'identification (catégorie `safe` uniquement)

Huit scripts, vérifiés présents dans l'installation Nmap 7.991 du poste, tous classés `safe` + `discovery` par Nmap :

| Script | Ce qu'il apprend |
|---|---|
| `smb-os-discovery` | nom Windows, domaine, version du système |
| `nbstat` | nom NetBIOS et adresse MAC |
| `http-title` | titre de la page web d'un appareil (« Livebox », « HP LaserJet… ») |
| `http-headers` | serveur web et technologies |
| `ssl-cert` | nom, émetteur et validité du certificat |
| `ssh-hostkey` | empreinte de la clé SSH (identifie l'appareil de façon stable) |
| `upnp-info` | modèle exact annoncé par les TV, box, imprimantes |
| `dns-service-discovery` | services annoncés en mDNS (AirPlay, Chromecast…) |

Plus, pour « Écouter le voisinage » : `broadcast-listener` et `broadcast-dhcp-discover` — ils écoutent les annonces du réseau sans sonder personne.

Le backend ne construit jamais `--script` à partir d'une chaîne : il assemble la liste **à partir des identifiants du catalogue**, puis vérifie que chaque nom appartient à la liste blanche.

### 4.5 Sécurité (non négociable)

En plus des garde-fous déjà en place (réseau privé seulement, cible issue de l'inventaire, un scan à la fois, limite de fréquence, audit, RBAC) :

1. **`build_argv()` reste la seule source de la ligne de commande.** Elle prend des identifiants d'options, pas des chaînes. Un identifiant inconnu → refus (400).
2. **Valeurs paramétrées strictement typées** : une plage de ports est relue par une expression dédiée (`^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?){0,31}$`), bornes 1–65535, 32 éléments au plus ; les entiers sont bornés (`--max-retries` 0–3, `--min-rate` ≤ 5000…). Aucun espace, aucun tiret initial, jamais de valeur libre.
3. **Liste blanche de scripts** : seuls les 10 noms ci-dessus, vérifiés un par un après construction.
4. **Plafonds de durée** : un profil appliqué à un sous-réseau est refusé si sa durée estimée dépasse 15 min (`-T0`/`-T1` + `-p-` par exemple). Sur un appareil unique : 10 min.
5. **Profils stockés en base** sous forme **d'identifiants d'options**, jamais de ligne de commande. Un profil enregistré hier est revalidé à chaque exécution contre le catalogue courant.
6. **Propriété** : un profil appartient à son créateur ; un analyste voit et exécute les siens, l'admin voit tout. Supprimer un profil n'efface pas l'historique des scans qui l'ont utilisé.

## 5. La fiche enrichie et l'historique

Ce que les scans rapportent vient compléter la fiche d'appareil existante :

- **Identité** : nom Windows/NetBIOS, modèle annoncé (UPnP), titre de la page web, certificat, empreinte SSH, système.
- **Applications** : par port, le logiciel et sa version, avec la source (« vu par Nmap le 02/10 à 14:03 »).
- **Historique des changements** : ce qui est apparu ou a disparu depuis le scan précédent (`net_port_history`), affiché en frise : « 02/10 — port 8080 ouvert (nouveau) », « 01/10 — version du serveur web passée de 1.2 à 1.3 ».

Traçabilité, comme partout dans DeTecTX : chaque ligne affichée dit d'où elle vient et quand.

## 6. Design de l'écran

La page Réseau local passe à **trois onglets** : `Sonar` · `Appareils` · **`Atelier`**.

- **Atelier, vue par défaut** : les 4 cartes d'objectifs en haut (grandes, une icône, la question en français, la durée), puis « Mes profils » en dessous (cartes compactes : nom, résumé des options, dernière exécution, boutons *Appliquer* / *Modifier* / *Supprimer*).
- **Appliquer** ouvre un sélecteur de cible : la liste des appareils de l'inventaire, ou « tout le réseau » si le profil le permet. Jamais un champ d'adresse libre.
- **Pendant un scan** : barre de progression indéterminée, profil et cible rappelés, bouton d'annulation. Le Sonar 3D tourne son faisceau plus vite (déjà en place).
- **Résultat** : la fiche de l'appareil s'ouvre sur ce qui a changé.
- **Cohérence** : mêmes composants que le reste du dashboard (`panel`, tons `accent`/`warn`/`critical`, pictogrammes `nav-icons`), aucune nouvelle dépendance.
- **Accessibilité** : cases à cocher réelles (navigables au clavier), aperçu de commande dans une zone `aria-live`, contrastes conformes au reste du dashboard.

## 7. Fichiers

### À créer
| Fichier | Rôle |
|---|---|
| `backend/app/network/options.py` | **Le catalogue** : ~40 options (id, libellé, flag, explication, coût, paramètre typé), groupes, incompatibilités, liste blanche de scripts. **Pur**, testable sans Nmap. |
| `backend/app/network/estimate.py` | Durée estimée d'un profil (pur) : ports × rythme × détection. |
| `backend/app/models/network_profile.py` | `NetScanProfile` : id, nom, options (JSON), portée, propriétaire, horodatages. |
| `backend/app/network/profiles.py` | CRUD des profils, validation contre le catalogue. |
| `backend/tests/test_nmap_options.py` | Catalogue, `build_argv`, injections, plafonds, incompatibilités. |
| `backend/tests/test_nmap_profiles.py` | CRUD, propriété, revalidation, routes. |
| `frontend/src/lib/nmap-options.ts` | Types, groupes, aperçu de commande (pur, miroir du catalogue serveur). |
| `frontend/src/components/network/workshop.tsx` | L'onglet Atelier : objectifs + mes profils. |
| `frontend/src/components/network/profile-builder.tsx` | Le constructeur visuel. |
| `frontend/src/components/network/target-picker.tsx` | Choix de la cible dans l'inventaire. |
| `frontend/src/components/network/device-history.tsx` | Frise des changements. |

### À modifier
- `backend/app/network/target.py` : `build_argv()` accepte un profil **composé** (liste d'identifiants) en plus des 4 profils figés.
- `backend/app/network/active.py` : exécution d'un profil composé, stockage des résultats enrichis (identité, scripts).
- `backend/app/models/network.py` : champs d'identité (`netbios_name`, `model`, `http_title`, `ssh_key`…) et table `net_port_history`.
- `backend/app/routers/network.py` : routes `/network/options`, `/network/profiles` (CRUD), `/network/scan` étendu.
- `frontend/src/app/dashboard/network/page.tsx` : les trois onglets.
- `docs/plans/reseau-nmap-sonar.md` : renvoi vers ce document.

## 8. Ordre de réalisation (un commit par étape)

| # | Étape | Contenu | Estimation |
|---|---|---|---|
| 1 | **Catalogue** | `options.py`, `estimate.py`, `build_argv` composé, tests d'injection et de plafonds. Rien d'exposé encore. | 1 j |
| 2 | **Profils** | modèle, CRUD, propriété, revalidation, routes `/network/options` et `/network/profiles`, tests. | 1 j |
| 3 | **Objectifs** | les 4 cartes + « Écouter le voisinage », résultats enrichis (identité, scripts), tests. | 1 j |
| 4 | **Historique** | `net_port_history`, frise des changements, tests. | 0,5 j |
| 5 | **Atelier (UI)** | onglets, cartes d'objectifs, constructeur visuel, aperçu, sélecteur de cible. | 2 j |
| 6 | **Finitions** | messages d'erreur, états vides, accessibilité, README, section du mémoire. | 0,5 j |

**Total : ~6 jours.** Chaque étape est vérifiable seule ; l'étape 1 ne change rien de visible, c'est voulu : la sécurité d'abord, l'interface ensuite.

## 9. Vérification de bout en bout

1. Réseau en **Privé** (fait : bouton livré au commit `de2304b`).
2. `pytest backend/tests/test_nmap_options.py` : les injections sont refusées — `"1-1024; calc"`, `"--script=vuln"`, `"-oN /tmp/x"`, un identifiant d'option inconnu, un script hors liste blanche, un profil dont la durée estimée dépasse le plafond.
3. Atelier → « Que fait cet appareil ? » sur la box : services, versions et système s'affichent en ~1 min.
4. « L'identifier précisément » sur la TV ou l'imprimante : le modèle exact apparaît.
5. « Écouter le voisinage » : les noms annoncés par les appareils du foyer remontent en ~20 s.
6. Créer un profil « Audit maison » (SYN + versions + système + ports 1-1024 + T4), l'enregistrer, l'appliquer à un appareil : la commande lancée correspond à l'aperçu (vérifiable dans l'historique des scans).
7. Relancer le même profil après avoir ouvert un port sur le PC : la frise affiche le changement.
8. Un analyste ne voit pas les profils d'un autre ; un lecteur ne peut ni créer ni exécuter (403).

## 10. Hors périmètre (roadmap du mémoire)

Rapprochement automatique version → CVE/KEV pour les appareils (le catalogue KEV est déjà téléchargé, mais la correspondance de versions demande une étude à part) ; planification de profils (« tous les lundis ») ; export d'un rapport PDF par appareil ; IPv6.
