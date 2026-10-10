#!/usr/bin/env bash
# Start OpenCode when it is not already listening, then run the Openview proxy
# in the foreground. Stopping this script stops only the OpenCode process it
# started. HOST, PORT, and OPENCODE_URL are passed through to server.mjs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
OPENCODE_URL="${OPENCODE_URL:-http://127.0.0.1:4096}"
export HOST PORT OPENCODE_URL

if ! command -v node >/dev/null 2>&1; then
  echo "node was not found on PATH. Openview needs Node.js." >&2
  exit 1
fi

port_open() {
  node --input-type=module -e '
    import net from "node:net"
    const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 1000 })
    const done = (code) => { socket.destroy(); process.exit(code) }
    socket.once("connect", () => done(0))
    socket.once("timeout", () => done(1))
    socket.once("error", () => done(1))
  ' "$1" "$2"
}

probe_host() {
  case "$1" in
    0.0.0.0|::|"") printf '%s\n' "127.0.0.1" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

url="${OPENCODE_URL%/}"
rest="${url#*://}"
rest="${rest%%/*}"
rest="${rest#*@}"
if [[ "$rest" == \[*\]* ]]; then
  oc_host="${rest#\[}"
  oc_host="${oc_host%%\]*}"
  oc_port="${rest##*:}"
else
  oc_host="${rest%%:*}"
  if [[ "$rest" == *:* ]]; then
    oc_port="${rest##*:}"
  elif [[ "$url" == https:* ]]; then
    oc_port=443
  else
    oc_port=80
  fi
fi

case "$oc_host" in
  127.0.0.1|localhost|::1) oc_local=1 ;;
  *) oc_local=0 ;;
esac

ui_host="$(probe_host "$HOST")"
if port_open "$ui_host" "$PORT"; then
  echo "Openview is already running at http://${ui_host}:${PORT}"
  exit 0
fi

OC_PID=""
cleanup() {
  if [[ -n "$OC_PID" ]] && kill -0 "$OC_PID" 2>/dev/null; then
    kill "$OC_PID" 2>/dev/null || true
    wait "$OC_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "$oc_local" -eq 1 ]]; then
  oc_probe="$(probe_host "$oc_host")"
  if port_open "$oc_probe" "$oc_port"; then
    echo "OpenCode is already running at ${OPENCODE_URL}"
  else
    if ! command -v opencode >/dev/null 2>&1; then
      echo "opencode was not found on PATH, and nothing is listening at ${OPENCODE_URL}." >&2
      exit 1
    fi
    oc_bind="127.0.0.1"
    log="${TMPDIR:-/tmp}/openview-opencode.log"
    echo "Starting OpenCode on http://${oc_bind}:${oc_port}"
    opencode serve --port "$oc_port" --hostname "$oc_bind" >"$log" 2>&1 &
    OC_PID=$!
    ready=0
    for _ in $(seq 1 40); do
      if ! kill -0 "$OC_PID" 2>/dev/null; then
        echo "OpenCode exited before it accepted connections. Log: ${log}" >&2
        tail -n 40 "$log" >&2 || true
        OC_PID=""
        exit 1
      fi
      if port_open "$oc_bind" "$oc_port"; then
        ready=1
        break
      fi
      sleep 0.25
    done
    if [[ "$ready" -ne 1 ]]; then
      echo "OpenCode did not start listening on ${oc_bind}:${oc_port}. Log: ${log}" >&2
      tail -n 40 "$log" >&2 || true
      exit 1
    fi
  fi
fi

echo "Starting Openview on http://${ui_host}:${PORT}"
node server.mjs
