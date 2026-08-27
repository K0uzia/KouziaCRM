#!/usr/bin/env bash
# Démarre / arrête Mailpit en binaire local (.tools/) : sans Docker.
# Nécessaire sur live USB / root overlay où Docker overlay échoue.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/.tools"
BIN="$TOOLS/mailpit"
PIDFILE="$TOOLS/mailpit.pid"
LOG="$TOOLS/mailpit.log"
SMTP_PORT="${MAILPIT_SMTP_PORT:-1025}"
UI_PORT="${MAILPIT_UI_PORT:-8025}"

arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "amd64" ;;
  esac
}

ensure_binary() {
  if [[ -x "$BIN" ]]; then
    return 0
  fi
  mkdir -p "$TOOLS"
  local archive="mailpit-linux-$(arch).tar.gz"
  local url="https://github.com/axllent/mailpit/releases/latest/download/${archive}"
  echo "Téléchargement de Mailpit…"
  curl -fsSL -o "$TOOLS/$archive" "$url"
  tar -xzf "$TOOLS/$archive" -C "$TOOLS" mailpit
  rm -f "$TOOLS/$archive"
  chmod +x "$BIN"
}

is_running() {
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  # déjà un process qui écoute le port SMTP
  if command -v ss >/dev/null 2>&1 && ss -lnt | grep -q ":${SMTP_PORT} "; then
    return 0
  fi
  return 1
}

start() {
  ensure_binary
  if is_running; then
    echo "Mailpit déjà actif"
    echo "Mailpit SMTP : 127.0.0.1:${SMTP_PORT}"
    echo "Mailpit UI   : http://127.0.0.1:${UI_PORT}"
    return 0
  fi
  mkdir -p "$TOOLS"
  nohup "$BIN" \
    --smtp "127.0.0.1:${SMTP_PORT}" \
    --listen "127.0.0.1:${UI_PORT}" \
    --smtp-auth-accept-any \
    --smtp-auth-allow-insecure \
    >"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 0.4
  if ! is_running; then
    echo "Échec démarrage Mailpit : voir $LOG" >&2
    exit 1
  fi
  echo "Mailpit SMTP : 127.0.0.1:${SMTP_PORT}"
  echo "Mailpit UI   : http://127.0.0.1:${UI_PORT}"
}

stop() {
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  # fallback : tuer le binaire local s'il tourne encore
  if [[ -x "$BIN" ]]; then
    pkill -f "$BIN" 2>/dev/null || true
  fi
  echo "Mailpit arrêté"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *)
    echo "Usage: $0 {start|stop}" >&2
    exit 1
    ;;
esac
