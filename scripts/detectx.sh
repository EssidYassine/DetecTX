#!/usr/bin/env bash
# DeTecTX — démarrer / arrêter le poste de surveillance en mode local (Windows, Git Bash).
#
#   scripts/detectx.sh start      lance le backend (API :8000) puis le dashboard (:3000)
#   scripts/detectx.sh stop       arrête les deux (processus qui écoutent sur 8000 et 3000)
#   scripts/detectx.sh restart    stop puis start
#   scripts/detectx.sh status     état des deux services
#   scripts/detectx.sh build      reconstruit le dashboard (après une modification du frontend)
#
# Aucun secret dans ce fichier :
#   - JWT_SECRET : variable d'environnement, sinon généré une fois dans backend/data/jwt-secret
#     (dossier ignoré par git) ;
#   - DISCORD_WEBHOOK_URL : variable d'environnement, sinon lu dans « START APP.txt » (ignoré).
# Journaux : logs/backend.log et logs/frontend.log (ignorés par git).

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/logs"
BACKEND_PORT=8000
FRONTEND_PORT=3000

# Outils introuvables dans le PATH de Git Bash : emplacements Windows habituels.
command -v python >/dev/null 2>&1 || PATH="/c/Python314:/c/Python314/Scripts:$PATH"
command -v npm >/dev/null 2>&1 || PATH="/c/Program Files/nodejs:$PATH"
PATH="$PATH:/c/WINDOWS/system32:/c/WINDOWS"

say() { printf '%s\n' "$*"; }

pid_on() { # PID qui écoute sur 127.0.0.1:<port> (vide si libre)
  netstat -ano 2>/dev/null | awk -v p=":$1" '$1 == "TCP" && $2 ~ p"$" && $4 == "LISTENING" { print $5; exit }'
}

image_of() { # nom de l'exécutable d'un PID (ex. node.exe)
  tasklist //FI "PID eq $1" //FO CSV //NH 2>/dev/null | head -1 | cut -d'"' -f2
}

wait_http() { # attend une réponse HTTP (max $2 secondes)
  local url=$1 limit=$2 i=0
  while [ "$i" -lt "$limit" ]; do
    curl -s -o /dev/null --max-time 2 "$url" && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

jwt_secret() {
  if [ -n "${JWT_SECRET:-}" ]; then printf '%s' "$JWT_SECRET"; return; fi
  local file="$ROOT/backend/data/jwt-secret"
  if [ ! -s "$file" ]; then
    mkdir -p "$(dirname "$file")"
    python -c "import secrets; print(secrets.token_urlsafe(48))" > "$file"
    say "  (clé JWT générée dans backend/data/jwt-secret : reconnectez-vous une fois au dashboard)" >&2
  fi
  tr -d '\r\n' < "$file"
}

discord_webhook() {
  if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then printf '%s' "$DISCORD_WEBHOOK_URL"; return; fi
  [ -f "$ROOT/START APP.txt" ] && grep -oE 'https://discord(app)?\.com/api/webhooks/[^" ]+' "$ROOT/START APP.txt" | head -1
}

start_backend() {
  if [ -n "$(pid_on $BACKEND_PORT)" ]; then say "• Backend déjà lancé (port $BACKEND_PORT)."; return 0; fi
  say "• Démarrage du backend (API, port $BACKEND_PORT)…"
  local secret webhook
  secret="$(jwt_secret)"
  webhook="$(discord_webhook)"
  (
    cd "$ROOT/backend" || exit 1
    DATABASE_URL="${DATABASE_URL:-sqlite+aiosqlite:///./detectx-dev.db}" \
      JWT_SECRET="$secret" \
      EVENTS_BACKEND="${EVENTS_BACKEND:-sql}" \
      DISCORD_WEBHOOK_URL="$webhook" \
      nohup python -m uvicorn app.main:app --host 127.0.0.1 --port $BACKEND_PORT >> "$LOGS/backend.log" 2>&1 &
  )
  if wait_http "http://127.0.0.1:$BACKEND_PORT/docs" 60; then
    say "  ✓ Backend prêt : http://127.0.0.1:$BACKEND_PORT/docs"
  else
    say "  ✗ Le backend ne répond pas : voir logs/backend.log"; return 1
  fi
}

build_frontend() {
  say "• Construction du dashboard (1 à 2 minutes)…"
  (cd "$ROOT/frontend" && npm run build >> "$LOGS/frontend.log" 2>&1) && say "  ✓ Dashboard construit." || { say "  ✗ Échec de la construction : voir logs/frontend.log"; return 1; }
}

start_frontend() {
  if [ -n "$(pid_on $FRONTEND_PORT)" ]; then say "• Dashboard déjà lancé (port $FRONTEND_PORT)."; return 0; fi
  [ -f "$ROOT/frontend/.next/BUILD_ID" ] || build_frontend || return 1
  say "• Démarrage du dashboard (port $FRONTEND_PORT)…"
  (cd "$ROOT/frontend" && nohup npm start >> "$LOGS/frontend.log" 2>&1 &)
  if wait_http "http://localhost:$FRONTEND_PORT/login" 60; then
    say "  ✓ Dashboard prêt : http://localhost:$FRONTEND_PORT"
  else
    say "  ✗ Le dashboard ne répond pas : voir logs/frontend.log"; return 1
  fi
}

stop_port() { # arrête le serveur DeTecTX sur ce port (seulement node/python, jamais autre chose)
  local port=$1 label=$2 pid image
  pid="$(pid_on "$port")"
  if [ -z "$pid" ]; then say "• $label : déjà arrêté."; return 0; fi
  image="$(image_of "$pid")"
  case "$image" in
    node.exe | python.exe | python3*.exe | pythonw.exe) ;;
    *) say "• $label : le port $port est occupé par « $image » (PID $pid), pas par DeTecTX : on n'y touche pas."; return 1 ;;
  esac
  taskkill //PID "$pid" //T //F >/dev/null 2>&1
  sleep 1
  if [ -z "$(pid_on "$port")" ]; then say "• $label arrêté."; else say "• $label : l'arrêt a échoué (PID $pid)."; return 1; fi
}

status() {
  local b f
  b="$(pid_on $BACKEND_PORT)"
  f="$(pid_on $FRONTEND_PORT)"
  say "Backend   (:$BACKEND_PORT) : $([ -n "$b" ] && echo "en marche, PID $b" || echo "arrêté")"
  say "Dashboard (:$FRONTEND_PORT) : $([ -n "$f" ] && echo "en marche, PID $f" || echo "arrêté")"
}

mkdir -p "$LOGS"
case "${1:-}" in
  start)
    start_backend && start_frontend && say "" && say "DeTecTX est prêt → http://localhost:$FRONTEND_PORT"
    ;;
  stop)
    stop_port $FRONTEND_PORT "Dashboard"
    stop_port $BACKEND_PORT "Backend"
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    status
    ;;
  build)
    build_frontend
    ;;
  *)
    say "Usage : scripts/detectx.sh {start|stop|restart|status|build}"
    exit 2
    ;;
esac
