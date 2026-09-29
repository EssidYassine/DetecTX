# DeTecTX

Plateforme de **détection Windows augmentée par IA** : collecte (Sysmon / Suricata / Zeek → OpenSearch) → moteur de détection maison (Sigma + YARA + corrélation) → **couche analyste IA** (LangChain/RAG) → dashboard temps réel → rapports.

> **Sans Wazuh** : DeTecTX construit lui-même la collecte et le moteur de détection. Voir [`CLAUDE.md`](CLAUDE.md) pour l'architecture complète.

## Lancer et arrêter (poste Windows, mode local)

Mode de développement : le backend surveille le poste sur lequel il tourne, sans Docker (SQLite, journaux Windows lus directement).
Prérequis : Python 3.14, Node.js, dépendances installées (`pip install -r backend/requirements.txt`, `npm install` dans `frontend/`).
Commandes à lancer depuis **Git Bash**, à la racine du projet :

```bash
scripts/detectx.sh start     # backend (API :8000) puis dashboard (:3000) → http://localhost:3000
scripts/detectx.sh stop      # arrête les deux
scripts/detectx.sh restart   # stop puis start
scripts/detectx.sh status    # état des deux services
scripts/detectx.sh build     # reconstruit le dashboard après une modification du frontend
```

- Les deux serveurs tournent en arrière-plan : le terminal peut être fermé. Journaux dans `logs/backend.log` et `logs/frontend.log`.
- Au démarrage, le backend lance seul la collecte des journaux Windows, les listes Threat Intel, l'analyse des vulnérabilités et la surveillance de la persistance.
- Secrets : `JWT_SECRET` est lu dans l'environnement, sinon généré une fois dans `backend/data/jwt-secret`. Le webhook Discord (`DISCORD_WEBHOOK_URL`) est lu dans l'environnement, sinon dans `START APP.txt`. Aucun des deux n'est versionné.
- `stop` n'arrête que les processus `node`/`python` qui écoutent sur 3000 et 8000. Si un autre programme occupe un de ces ports, le script le signale sans y toucher.

## Démarrage rapide (stack complète Docker)

Prérequis : Docker + Docker Compose.

```bash
cp .env.example .env
# éditer .env : mots de passe, JWT_SECRET, clés API...
cd infra
docker compose up -d --build
```

Services exposés :

| Service | URL |
|---|---|
| API backend (FastAPI) | http://localhost:8000 · docs : http://localhost:8000/docs |
| Health check | http://localhost:8000/health |
| OpenSearch | http://localhost:9200 |
| OpenSearch Dashboards | http://localhost:5601 |
| PostgreSQL | localhost:5432 |
| Redis | localhost:6379 |

Vérifier que tout est UP :

```bash
curl http://localhost:8000/health
```

## Structure

```
detectx/
├── frontend/     # Next.js dashboard        (Phase 5)
├── backend/      # FastAPI + détection + IA  (Phases 3-6)
├── collectors/   # Sysmon, Suricata, Zeek    (Phase 2)
├── infra/        # docker-compose + services (Phase 1) ✅
└── docs/         # manuel utilisateur        (Phase 9)
```

## Sécurité (dev vs prod)

⚠️ La config par défaut est **pour le développement** : le plugin de sécurité OpenSearch est désactivé et les mots de passe sont des placeholders. **Avant tout déploiement** : réactiver `DISABLE_SECURITY_PLUGIN`, générer des secrets forts, activer TLS.
