#!/usr/bin/env bash
# Démarre / arrête Mailpit en binaire local (.tools/) : sans Docker.
# Nécessaire sur live USB / root overlay où Docker overlay échoue.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/.tools"
PIDFILE="$TOOLS/mailpit.pid"
LOG="$TOOLS/mailpit.log"
SMTP_PORT="${MAILPIT_SMTP_PORT:-1025}"
UI_PORT="${MAILPIT_UI_PORT:-8025}"

os_family() {
  case "$(uname -s)" in
    Linux*) echo "linux" ;;
    Darwin*) echo "darwin" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "linux" ;;
  esac
}

arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "amd64" ;;
  esac
}

bin_path() {
  if [[ "$(os_family)" == "windows" ]]; then
    echo "$TOOLS/mailpit.exe"
  else
    echo "$TOOLS/mailpit"
  fi
}

BIN="$(bin_path)"

ensure_binary() {
  if [[ -f "$BIN" ]]; then
    return 0
  fi
  mkdir -p "$TOOLS"
  # Ancien binaire Linux incompatible sous Git Bash / Windows
  rm -f "$TOOLS/mailpit" "$TOOLS/mailpit.exe" "$TOOLS/mailpit.pid"

  local family archive url
  family="$(os_family)"
  if [[ "$family" == "windows" ]]; then
    archive="mailpit-windows-$(arch).zip"
    url="https://github.com/axllent/mailpit/releases/latest/download/${archive}"
    echo "Téléchargement de Mailpit (Windows)…"
    curl -fsSL -o "$TOOLS/$archive" "$url"
    if command -v unzip >/dev/null 2>&1; then
      unzip -o -q "$TOOLS/$archive" mailpit.exe -d "$TOOLS"
    else
      powershell.exe -NoProfile -Command \
        "Expand-Archive -Force -Path '$TOOLS/$archive' -DestinationPath '$TOOLS'"
    fi
    rm -f "$TOOLS/$archive"
  else
    archive="mailpit-${family}-$(arch).tar.gz"
    url="https://github.com/axllent/mailpit/releases/latest/download/${archive}"
    echo "Téléchargement de Mailpit…"
    curl -fsSL -o "$TOOLS/$archive" "$url"
    tar -xzf "$TOOLS/$archive" -C "$TOOLS" mailpit
    rm -f "$TOOLS/$archive"
    chmod +x "$BIN"
  fi

  if [[ ! -f "$BIN" ]]; then
    echo "Échec extraction Mailpit ($BIN introuvable)" >&2
    exit 1
  fi
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
  # Windows / Git Bash : netstat
  if command -v netstat >/dev/null 2>&1 && netstat -an 2>/dev/null | grep -Eq "[:.]${SMTP_PORT}[[:space:]].*LISTEN"; then
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
  sleep 0.8
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
  if [[ -f "$BIN" ]]; then
    pkill -f "$BIN" 2>/dev/null || true
  fi
  # Windows : taskkill si besoin
  if [[ "$(os_family)" == "windows" ]]; then
    taskkill //F //IM mailpit.exe >/dev/null 2>&1 || true
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
