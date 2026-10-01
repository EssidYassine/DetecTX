# Plan — Réseau local : « le Sonar » (Nmap + vue 3D Blender)

> Statut : **proposé**, rien n'est implémenté. Rédigé le 2026-10-02.

## 1. Contexte et objectif

DeTecTX surveille aujourd'hui **le poste** : journaux, processus, ports en écoute, persistance. Il ne sait rien des **autres appareils du réseau local** : box, téléphones, TV, caméras, imprimantes, ou un intrus branché sur le Wi-Fi.

Objectif : répondre simplement à trois questions de l'utilisateur.
1. **Qui est sur mon réseau ?** C'est un inventaire des appareils : type, fabricant, nom.
2. **Qu'est-ce qui a changé ?** Un nouvel appareil, un port qui s'ouvre, une passerelle dont l'identité change.
3. **Est-ce dangereux, et que faire ?** Le risque est expliqué, avec un conseil et un lien vers la technique MITRE.

Règle d'or respectée : **on n'écrit pas de scanner**. On pilote **Nmap**, composant tiers de référence, et DeTecTX apporte l'intelligence (référence, détection des changements, explication) et l'UX.

Nom de la page : **le Sonar**, dans la lignée de la Ruche (MITRE) et du Tamis (Threat Intel). Nmap « émet » des sondes et les appareils renvoient des « échos ».

### Ce que le Sonar fait et ne fait pas (à écrire tel quel dans le mémoire)
| Fait | Ne fait pas |
|---|---|
| Inventaire des appareils du LAN, ports et services ouverts | Analyse du trafic échangé entre appareils (rôle de Suricata/Zeek, phase 2) |
| Alerte : nouvel appareil, nouveau port, ARP usurpé, passerelle changée | Bloquer un appareil (DeTecTX ne pilote pas la box) |
| Explication du risque par port (catalogue existant) | Scanner hors du sous-réseau local ou sur un réseau public |
| Fonctionne sans Nmap, en mode passif dégradé | Scripts NSE intrusifs (`vuln`, `brute`, `exploit`) |

## 2. Architecture : deux couches complémentaires

```
                ┌──────────────────────── backend ────────────────────────┐
 Table ARP  ──► │ Couche PASSIVE (toutes les 60 s, sans Nmap, sans admin) │
 de Windows     │   voisins IP↔MAC  → usurpation ARP, nouvel appareil     │
                │                                                         │
 nmap.exe   ──► │ Couche ACTIVE                                           │──► réconciliation avec la
 (-oX XML)      │   découverte -sn  (toutes les 15 min, sans UAC)         │    référence → alertes
                │   scan rapide     (à la demande, sans UAC)              │    (save_alerts + Discord)
                │   scan complet    (à la demande, via UAC : -sS -O)      │
                └─────────────────────────────────────────────────────────┘
                                         │ /network/*
                                         ▼
                 Page « Réseau » : Sonar 3D (GLB Blender) + liste + fiche appareil
```

- **Couche passive** : lit la table des voisins de Windows **en natif** (`iphlpapi` : `GetBestRoute`, `GetIpAddrTable`, `GetIpNetTable2`, via ctypes), en environ 125 ms. Elle tourne en continu, ne demande aucun droit et ne dépend pas de Nmap. C'est elle qui détecte l'**usurpation ARP**, c'est-à-dire l'IP de la passerelle qui répond avec une autre MAC.
  - *Décision (étape 1)* : pas de `Get-NetNeighbor`. Lancer PowerShell toutes les minutes écrirait dans le journal PowerShell que DeTecTX collecte lui-même (événements 400/4104).
  - *Décision (étape 1)* : seule l'interface de la route par défaut est lue. Les cartes virtuelles (VMware, WSL, Hyper-V) sont ignorées.
  - *Décision (étape 1)* : un réseau est identifié par **son nom Windows (SSID) + sous-réseau + IP de passerelle**. Beaucoup de box utilisent `192.168.1.1` : sans le nom, passer de la maison au café serait pris pour une usurpation.
- **Couche active** : Nmap. Elle enrichit l'inventaire : services, versions, système, fabricant. Si Nmap est absent, la page le dit et la couche passive continue seule.

## 3. Backend

### 3.1 Fichiers à créer
| Fichier | Rôle |
|---|---|
| `backend/app/models/network.py` | Tables `net_devices`, `net_ports`, `net_scans` |
| `backend/app/network/__init__.py` | Paquet |
| `backend/app/network/target.py` | **Fonctions pures** : sous-réseau local, validation des cibles, construction de la ligne de commande Nmap |
| `backend/app/network/nmap_runner.py` | Localisation de `nmap.exe`, exécution (verrou, délais), parsing XML |
| `backend/app/network/neighbors.py` | Lecture de la table ARP (couche passive) |
| `backend/app/network/classify.py` | **Pure** : type d'appareil (box, PC, téléphone, caméra, imprimante, TV, NAS, IoT, inconnu) |
| `backend/app/network/oui.py` | Fabricant à partir de la MAC, lu dans `nmap-mac-prefixes` du dossier Nmap (aucune base embarquée) |
| `backend/app/network/service.py` | Réconciliation avec la référence (passive), alertes appareil et passerelle |
| `backend/app/network/active.py` | Garde-fou, fusion Nmap + ARP, enrichissement, référence des ports *(ajouté à l'étape 2)* |
| `backend/app/network/sonar.py` | Boucle : ARP chaque minute, découverte 15 min, ports 6 h ; `status()` pour l'API *(ajouté à l'étape 2)* |
| `backend/app/routers/network.py` | Routes `/network/*` |
| `backend/app/schemas/network.py` | Schémas Pydantic |

### 3.2 Fichiers à modifier
- `backend/app/main.py` : inclure le routeur et lancer `network.service.run_forever()` dans `lifespan`, sur le modèle de `persistence.run_forever()`.
- `backend/app/config.py` : `NETWORK_WATCH` (vrai par défaut), `NETWORK_ACTIVE_SCAN` (vrai), `NMAP_PATH` (vide = emplacements standards).
- `backend/app/services/attack.py` : déclarer les nouvelles règles et la source « Réseau » pour que la Ruche les compte.
- `backend/requirements.txt` : ajouter **`defusedxml`** pour lire le XML de Nmap sans risque XXE.
- `.env.example` : documenter les trois variables.

### 3.3 Briques existantes réutilisées
| Besoin | Brique existante |
|---|---|
| Référence « connu / nouveau / approuvé » | Modèle de `services/persistence.py` (`reconcile`, `approve`, `reset_baseline`) |
| Création d'alertes et déduplication | `services/alerts.py:save_alerts` (`dedup_key`) |
| Discord | `app/notify.py` (`notify_alerts`) |
| Élévation UAC | `services/elevation.py:run_elevated` + assistant autonome (cf. `fw_helper.py`) |
| Catégorie du réseau (public / privé) | `services/firewall.py:read_state()` → `state.networks[].category` |
| Risque et conseil par port | `detection/port_risk.py` (`CATALOG`) |
| RBAC | `deps.py:require_role` |
| Journal d'audit | `app/audit.py` |

### 3.4 Modèle de données
```
net_devices  id (empreinte de la MAC, sinon de l'IP)  mac  ip  hostname  vendor  kind  os_guess
             randomized_mac (bool)  is_gateway (bool)  label (nom donné par l'utilisateur)
             status baseline|new|approved   first_seen  last_seen  source passive|nmap
net_ports    device_id  proto  port  service  product  version  status baseline|new  first_seen  last_seen
net_scans    id  profile  target  actor  started_at  finished_at  hosts_up  ok  error
```
Comme pour la persistance, le **premier passage constitue la référence**, ce qui évite une avalanche d'alertes au premier lancement. Un bouton « Nouvelle référence » permet de la reconstruire.

### 3.5 Profils de scan (aucun argument libre)
L'utilisateur choisit un **profil**, jamais des options Nmap. La ligne de commande est construite **uniquement** par `target.build_argv(profile, target)` :

Profils réellement implémentés (étape 2, `app/network/target.py`). Tous se terminent par `--noninteractive -oX -` :

| Profil | Arguments | Durée mesurée (/24) | Déclenchement |
|---|---|---|---|
| `discovery` | `-sn -T4 --max-retries 1 --host-timeout 20s` | ≈ 3 s | toutes les 15 min |
| `discovery-unprivileged` | `-sn --unprivileged …` | ≈ 3 s | repli si Npcap refuse les paquets bruts |
| `ports` | `-sS --top-ports 100 -T4 --max-retries 1 --host-timeout 60s` | ≈ 13 s | toutes les 6 h |
| `deep` | `-sS -sV --version-light -O --osscan-limit --top-ports 1000 …` | ≈ 1 min / appareil | à la demande, sur **un** appareil (API, étape 3) |

*Décisions (étape 2), issues des essais sur un vrai réseau :*
- **Scan SYN, jamais par connexion (`-sT`)**. L'antivirus du poste (Avast) intercepte les connexions sortantes vers les ports mail : en `-sT`, la box montrait 25, 110, 143, 587, 993… « ouverts » (*« Avast! anti-virus proxy, cannot connect »*), et **tous** les appareils l'auraient fait. En SYN, la box montre ses 4 vrais ports.
- **Pas d'élévation UAC** : Npcap (réglage par défaut) autorise les paquets bruts sans droits administrateur, y compris pour `-sS` et `-O`. L'assistant `nmap_helper.py` est donc **abandonné**, ce qui fait moins de code privilégié. Si Npcap est réservé aux administrateurs, la découverte se replie sur `--unprivileged`, et le scan de ports est **déclaré indisponible** plutôt que faussé.
- **Résolution des noms conservée** (pas de `-n`) : les noms annoncés par la box (`iPhone.lan`, `Galaxy-A04.lan`…) sont le meilleur indice de type.
- **Détection de système = indice faible** : la box (OpenWrt) sort « Android 9, 98 % ».

Aucun script NSE n'est activé.

### 3.6 Sécurité (non négociable)
1. **Cible** : `ipaddress.ip_network(strict=True)`. Elle doit être **privée** (RFC 1918), **incluse dans un sous-réseau d'une interface locale** (`psutil.net_if_addrs`), avec un préfixe **≥ /22** (1 024 hôtes au plus). Une cible « un appareil » ne peut être qu'un `device_id` **de l'inventaire** : l'API ne reçoit jamais une IP libre. C'est le même principe que les remèdes, qui n'acceptent que des identifiants de l'inventaire.
2. **Exécution** : `subprocess.run(argv_list, shell=False, timeout=…)`. L'exécutable est résolu depuis `NMAP_PATH` ou `Program Files (x86)\Nmap\nmap.exe`, et sa présence est vérifiée. Il ne vient jamais d'une entrée utilisateur.
3. **Réseau public** : si la catégorie Windows du réseau connecté est `public` (café, école, hôtel), **la couche active est refusée** (409, avec explication). La couche passive reste active, puisqu'elle ne fait que lire la table locale. Pour scanner chez soi, il suffit de passer le réseau en « Privé » dans Windows. Pas de contournement silencieux.
4. **XML** : `defusedxml.ElementTree.fromstring`, avec taille de sortie plafonnée (par exemple 5 Mo) et champs tronqués avant stockage.
5. **Concurrence et abus** : un seul scan à la fois (verrou), au plus un scan à la demande par minute et par utilisateur (429), et un délai global par profil.
6. **RBAC** : `viewer` ne fait que lire ; `analyst` et `admin` lancent des scans et approuvent des appareils.
7. **Audit** : chaque scan (profil, cible, acteur, résultat), approbation, renommage et nouvelle référence est journalisé.
8. ~~**Assistant UAC** (`nmap_helper.py`)~~ : abandonné à l'étape 2, l'élévation n'est pas nécessaire (voir 3.5).
9. **Catégorie inconnue = refus** : si Windows ne donne pas la catégorie du réseau, la couche active est suspendue par prudence.

### 3.7 Détections (le cœur « puissant et non typique »)
| `rule_id` | Déclencheur | Sévérité | MITRE |
|---|---|---|---|
| `network-gateway-mac-change` ✅ | La MAC de la **passerelle** change. Si cette MAC est aussi celle d'un autre appareil, l'alerte le nomme : c'est la signature de l'homme du milieu | **critique** si le réseau est nommé, élevée sinon | T1557.002 (ARP Cache Poisoning) |
| `network-new-device` ✅ | MAC jamais vue (après la référence et l'apprentissage) | moyenne ; faible si MAC privée | T1200 (Hardware Additions) |
| `network-new-port` ✅ | Port ouvert absent de la référence de l'appareil | selon `port_risk` | selon `port_risk` (T1021, T1190…) |
| `network-risky-service` ✅ | Au **premier** scan d'un appareil, service à risque élevé ou critique exposé (Telnet, SMB, RDP, base de données…) | selon `port_risk` | selon `port_risk` |

*Décision (étape 1)* : la règle `network-arp-conflict` prévue au départ est **fusionnée** dans `network-gateway-mac-change`. Pour les IP autres que la passerelle, « une IP connue répond avec une autre MAC » arrive à chaque renouvellement de bail DHCP : ce serait une source de faux positifs permanente.

*Décisions (étape 2)* :
- **Période d'apprentissage** (`NETWORK_LEARNING_HOURS`, 24 h) : la table ARP ne montre que les appareils qui ont parlé au poste, et le reste du foyer y apparaît au fil des heures. Sans apprentissage, la première journée produirait une alerte par téléphone du foyer (constaté : 4 fausses alertes le premier soir). La passerelle reste contrôlée dès la première minute. Le compromis est assumé : un intrus arrivé pendant ces 24 h rejoint la référence, mais reste visible dans l'inventaire.
- **La première découverte Nmap élargit la référence**, sans alerte « nouvel appareil », pour la même raison.
- **Un port refermé puis rouvert n'est pas une nouveauté** (le port reste dans la référence de l'appareil).

Les finesses qui font la qualité et réduisent les faux positifs :
- **MAC aléatoire** (bit « administré localement ») : l'appareil est étiqueté « téléphone ou tablette, adresse privée ». Un téléphone qui change de MAC à chaque reconnexion ne doit pas déclencher une alerte « nouvel appareil » à chaque fois. On le rapproche par nom d'hôte quand c'est possible, sinon l'alerte est de sévérité faible.
- **Disparition ≠ suppression** : un appareil éteint reste dans la référence (`last_seen` fige), comme pour la persistance. Son retour n'est pas une nouveauté.
- **Chaque alerte cite ses preuves** : ancienne et nouvelle MAC, source (ARP ou Nmap), date du scan, ligne XML. C'est la règle de traçabilité du projet.

### 3.8 Routes `/network`
```
GET    /network/status               Nmap installé ? version, Npcap, sous-réseau, catégorie du réseau, dernier scan
GET    /network/devices              inventaire (+ ports, statut, risque agrégé)
GET    /network/devices/{id}         fiche : ports, conseils port_risk, historique
PATCH  /network/devices/{id}         label, approbation                 (analyst+, audit)
POST   /network/scan                 {profile, device_id?}              (analyst+, audit, 429, 409 si réseau public)
GET    /network/scans                derniers scans
POST   /network/baseline             nouvelle référence                 (admin, audit)
```

## 4. Blender : l'actif 3D du Sonar

Blender sert ici comme pour les 17 widgets existants : **outil hors ligne** qui génère un `.glb` et une image de remplacement. three.js anime ensuite la scène avec les données réelles. Blender ne tourne pas dans l'application.

### 4.1 `assets/3d/build_sonar.py` (s'appuie sur `dtx3d.py`)
Usage : `blender --background --python assets/3d/build_sonar.py`
Sorties : `frontend/public/models/sonar.glb` (**< 600 Ko**, comme les autres) et `sonar_poster.png` (fond transparent).

Scène : une **coupole de sonar** vue en plongée.
- **Plateau** circulaire gradué avec anneaux de distance et secteurs angulaires : infrastructure, ordinateurs, mobiles, objets connectés, inconnus.
- **Moyeu** : la box ou passerelle au centre (`Sonar_Gateway`, matériau émissif `MAT_SonarCore`).
- **Faisceau** de balayage (`Sonar_Beam`, cône translucide) : three.js le fait tourner pendant un scan.
- **Glyphes d'appareils**, un maillage par type et instanciés par three.js : `Glyph_Router`, `Glyph_PC`, `Glyph_Phone`, `Glyph_Camera`, `Glyph_Printer`, `Glyph_TV`, `Glyph_NAS`, `Glyph_IoT`, `Glyph_Unknown`. Silhouettes simples et lisibles en petit, dans le style « dtx » (métal sombre et arêtes émissives).

**Contrat Blender ↔ web** (en tête du script et du composant, comme `build_netmap.py` et `network-map.tsx`) : noms des objets ci-dessus, constantes `RING_TRUSTED`, `RING_KNOWN`, `RING_NEW`, `GROUND_TOP`, `SECTORS`.

### 4.2 Lecture visuelle (ce qui rend la vue non typique)
- **Angle** = type d'appareil (secteur) ; position dans le secteur = hachage stable de l'id (pas de saut d'un rafraîchissement à l'autre, comme `network-map.tsx`).
- **Rayon** = confiance : approuvé au centre, connu au milieu, **nouveau en bord de coupole**. Un intrus se voit donc « à la porte ».
- **Hauteur et couleur de l'écho** = exposition : nombre et risque des ports ouverts, avec la palette de sévérité existante.
- **Faisceau** : il tourne pendant un scan, et chaque écho « s'allume » quand le faisceau passe dessus et que Nmap l'a vu.
- **Alerte ARP** : l'écho de la passerelle se dédouble (deux silhouettes décalées) avec une pulsation rouge. C'est le visuel de l'usurpation.
- **Repli** : `ScenePoster` si WebGL est indisponible, et `prefers-reduced-motion` respecté (pas de balayage animé).

## 5. Frontend

> Avant d'écrire du code, lire le guide de cette version de Next.js : `frontend/node_modules/next/dist/docs/` (cf. `frontend/AGENTS.md`).

| Fichier | Rôle |
|---|---|
| `frontend/src/app/dashboard/network/page.tsx` | Page « Réseau » |
| `frontend/src/components/three/sonar.tsx` | Scène 3D (import via `next/dynamic({ ssr: false })`, `useGLTF`, `scene-kit.tsx`) |
| `frontend/src/components/network/device-list.tsx` | Liste filtrable : nouveaux en tête, type, fabricant, IP, risque |
| `frontend/src/components/network/device-drawer.tsx` | Fiche : ports et conseils, « Approuver », « Renommer », « Analyser cet appareil » (rapide / complet) |
| `frontend/src/components/network/scan-bar.tsx` | État de Nmap, catégorie du réseau, dernier scan, bouton de scan |
| `frontend/src/lib/network.ts` | Types et placement pur (angle, rayon, hauteur), testable |
| `frontend/src/lib/api.ts` | Appels `/network/*` |
| `frontend/src/components/nav/sidebar.tsx` | Entrée « Réseau » dans « Surveiller », après « Système », avec badge du nombre de nouveaux appareils |

États vides soignés, parce qu'ils font la facilité d'utilisation :
- **Nmap absent** : « Mode passif : DeTecTX voit les appareils qui ont parlé à ce PC. Pour un inventaire complet, installez Nmap (avec Npcap) depuis nmap.org, puis rafraîchissez. » Pas de téléchargement automatique.
- **Réseau public** : « Scan désactivé sur un réseau public. Chez vous ? Passez ce réseau en Privé dans les paramètres Windows. »

## 6. Tests

`backend/tests/test_network.py`, sur le modèle de `test_firewall_actions.py` et `test_system_hardening.py`. Les fonctions pures sont testées sans Windows ni Nmap :
- **Validation de cible** : refuse une IP publique, `/16`, `0.0.0.0/0`, une IPv6 hors lien, un sous-réseau qui n'est pas local, et des injections comme `"192.168.1.0/24 -oN x"`, `"192.168.1.1;calc"` ou `"--script=vuln"`.
- **`build_argv`** : pour chaque profil, l'argv est exactement celui attendu et aucune chaîne utilisateur n'y figure.
- **Parsing XML** : fixtures `tests/fixtures/nmap_*.xml` (découverte, ports et services, hôte injoignable), plus une **charge XXE ou « billion laughs » rejetée**.
- **`classify`** : imprimante (9100/631), caméra (554 et fabricant), TV (8008/8009), PC (445/3389), MAC aléatoire classée en téléphone.
- **Réconciliation** : référence sans alerte ; nouvel appareil = alerte ; MAC de la passerelle changée = **critique** ; nouveau port = sévérité `port_risk` ; appareil disparu puis revenu = pas d'alerte ; déduplication.
- **Garde réseau public** : `POST /network/scan` renvoie 409.
- **RBAC** : `viewer` reçoit 403 sur scan, approbation et nouvelle référence. **429** sur des scans trop rapprochés.
- **Assistant UAC** : `nmap_helper.py` refuse seul les arguments hors contrat (code 2).

Frontend : `npm run lint` et `npm run build`. Blender : lancer `build_sonar.py` en mode headless, vérifier la taille du GLB et la présence des objets du contrat.

## 7. Ordre de réalisation (un commit par étape)
1. **Couche passive** : modèle, `neighbors.py`, `classify.py`, réconciliation et alertes ARP et nouvel appareil, tests.
2. **Couche Nmap** : `target.py`, `nmap_runner.py`, `oui.py`, parsing sécurisé, garde réseau public, tests.
3. **API** : routeur, RBAC, audit, limite de débit, `run_forever`, config. Plus `nmap_helper.py` (UAC) et ses tests.
4. **Blender** : `build_sonar.py`, puis `sonar.glb` et `sonar_poster.png`.
5. **Frontend** : page, Sonar 3D, liste, fiche, barre de scan, navigation.
6. **Intégration** : règles dans la Ruche MITRE, `.env.example`, README, section du mémoire.

## 8. Vérification de bout en bout
1. Installer **Nmap + Npcap** depuis nmap.org (à faire par l'utilisateur).
2. `scripts/detectx.sh restart`, puis `GET /network/status` doit indiquer Nmap détecté et le réseau en privé.
3. Page Réseau : la découverte peuple le Sonar et la liste. La passerelle est au centre et les appareils sont classés.
4. Lancer un **scan rapide** sur un appareil, puis un **scan complet** : l'invite UAC apparaît, et un refus laisse le système inchangé.
5. **Nouvel appareil** : connecter un téléphone ou une tablette au Wi-Fi. L'alerte « nouvel appareil » arrive dans Alertes (et sur Discord), et l'écho apparaît en bord de coupole.
6. **Réseau public** : passer le réseau en « Public » dans Windows. Le scan est refusé avec un message clair et la couche passive continue.
7. **Usurpation ARP** : à valider **dans une VM ou un labo isolé** (par exemple avec `arpspoof` entre deux VM), jamais sur un réseau partagé. Cela rejoint la phase 8 (tests défensifs).
8. `pytest backend/tests/test_network.py` passe au vert, ainsi que le lint et le build du frontend.

## 9. Hors périmètre (roadmap)
Analyse du trafic (Suricata/Zeek) ; détection d'un serveur DHCP pirate (`broadcast-dhcp-discover`, script NSE à évaluer) ; rapprochement des versions de services avec CISA KEV ; blocage d'un appareil via l'API de la box ; IPv6.
