# DeTecTX

Plateforme de **détection Windows augmentée par IA** : collecte (Sysmon / Suricata / Zeek → OpenSearch) → moteur de détection maison (Sigma + YARA + corrélation) → **couche analyste IA** (LangChain/RAG) → dashboard temps réel → rapports.

> **Sans Wazuh** : DeTecTX construit lui-même la collecte et le moteur de détection. Voir [`CLAUDE.md`](CLAUDE.md) pour l'architecture complète.

## Démarrage rapide

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
