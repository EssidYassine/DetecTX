# DeTecTX — Plateforme de détection Windows augmentée par IA

> SOC pour un endpoint Windows : collecte → détection → corrélation → **couche IA analyste** → dashboard → rapports.
> **Décision fondatrice : on n'utilise PAS Wazuh.** DeTecTX construit lui-même la collecte et le moteur de détection. C'est là qu'est la valeur et l'originalité du projet.

## Vision
Ce n'est pas un énième SIEM. C'est une **couche analyste augmentée par l'IA** posée sur une stack de collecte/détection maison, qui transforme une file d'alertes brutes en **verdicts + récits d'attaque sourcés + remédiation**. Chaque affirmation produite par un LLM est **traçable** (référence l'alerte/log/IOC qui la fonde) — pas de « boîte noire ».

## Architecture (sans Wazuh)
```
Windows Endpoint (Sysmon)
        │  Winlogbeat / Fluent Bit
        ▼
   OpenSearch  ◄── Suricata + Zeek (réseau)
        │
   API Backend (FastAPI)
        │
   Moteur de détection maison  ── Sigma (pySigma→OpenSearch) + YARA + corrélation + score de risque
        │
   Couche IA (LangChain / RAG / multi-agents)
        │
   Dashboard Next.js (temps réel)
```

## Stack
- **Frontend** : Next.js · React · TypeScript · TailwindCSS · shadcn/ui · Chart.js · React Flow · Socket.io
- **Backend** : FastAPI · Python · Celery · Redis · REST · WebSocket
- **Données** : OpenSearch (events/logs) · PostgreSQL (app : users, incidents, verdicts, rapports, IOCs, règles) · Redis (cache/queue)
- **Collecte / détection** : Sysmon · Winlogbeat/Fluent Bit · Suricata · Zeek · **Sigma (pySigma)** · **YARA**
- **IA** : LangChain · RAG · abstraction provider → OpenAI **ou** Anthropic **ou** Ollama local (mode air-gapped)
- **Threat Intel** : VirusTotal · AbuseIPDB · AlienVault OTX · MISP
- **Infra** : Docker · Docker Compose · Nginx/Traefik · Prometheus · Grafana · GitHub Actions

## Arborescence cible (monorepo)
```
detectx/
├── frontend/        # Next.js dashboard
├── backend/         # FastAPI (API, auth, alertes)
│   ├── detection/   # moteur maison : Sigma, YARA, corrélation, scoring
│   ├── ai/          # LangChain : triage, explication, assistant RAG, génération de règles
│   └── threatintel/ # connecteurs VT / AbuseIPDB / OTX / MISP
├── collectors/      # config Sysmon, Winlogbeat/Fluent Bit, Suricata, Zeek
├── infra/           # docker-compose, OpenSearch, PostgreSQL, Redis, reverse proxy
└── docs/            # README, manuel utilisateur
```

## Sécurité (non négociable — c'est un produit sécurité)
JWT · MFA (TOTP) · RBAC (admin/analyst/viewer) · HTTPS · Audit log · AES · bcrypt · Rate limiting · Validation stricte des entrées · Protections CSRF/XSS/SQLi. Secrets via variables d'env, jamais en dur. Chaque module doit passer un audit OWASP avant d'être considéré « fait ».

## Routage des skills (quel skill pour quelle tâche)
| Tâche | Skill à utiliser |
|---|---|
| Règles YARA | `yara-rule-authoring` (Trail of Bits) |
| Règles Sigma / détection | `building-detection-rules-with-sigma` |
| Auth (JWT/MFA/RBAC/rate-limit) | `better-auth-security-best-practices` |
| Audit sécu d'un module / agent IA | `agent-owasp-compliance` |
| Assistant SOC RAG | `langchain-rag` |
| Validation humaine des verdicts | `langgraph-human-in-the-loop` |
| Mémoire de contexte IA | `deep-agents-memory` |
| UI / composants | `shadcn` → `kpi-dashboard-design` → `design-taste-frontend` |
| Docker | `multi-stage-dockerfile` |
| Prompts LLM | `prompt-engineering-patterns` |
| Créer un skill DeTecTX sur mesure | `skill-creator` |
| Rapports / prose / manuel | `writing-guidelines` |

## Conventions
- Python : type hints, `ruff` + `black`, tests `pytest`. TS : strict mode, ESLint. Suivre le code existant.
- Toute sortie IA doit citer sa source (alerte/log/IOC). Posture par défaut **conservatrice** : l'IA recommande, l'humain agit.
- Règle d'or de scope : si une fonctionnalité existe déjà dans un composant tiers déployé, on l'utilise, on ne la réimplémente pas. Le code DeTecTX ne produit que ce que les tiers ne font pas : **l'intelligence et l'UX de décision**.

## Plan par phases
1. **Infra** — Docker, OpenSearch, PostgreSQL, Redis
2. **Collecte** — Sysmon, Winlogbeat/Fluent Bit, Suricata/Zeek → OpenSearch
3. **Backend** — API, auth, gestion des alertes
4. **Moteur de détection** — Sigma (pySigma), YARA, corrélation, scoring *(cœur du projet)*
5. **Dashboard** — interface, temps réel, recherche, graphiques
6. **IA** — triage/récit d'attaque, explication d'alerte, assistant RAG, génération de rapports
7. **Threat Intel** — VT, AbuseIPDB, OTX, MISP
8. **Tests défensifs** — Atomic Red Team, Caldera (valider les détections)
9. **Déploiement** — Docker Compose, README, manuel utilisateur

## Hors périmètre PFE
Antivirus, EDR kernel, firewall. Multi-endpoints, agents Linux/macOS, ML maison, SOAR complet, forensic disque/mémoire → roadmap future (à citer dans le mémoire).
