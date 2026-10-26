#!/bin/zsh
# Starts Agentic OS (localhost:4317) and opens it in the default browser. If it is already
# running, restarts it first, without asking: the server and the PTY host, so both load the
# current code. A supervised server does it itself (POST /api/system/restart), so this also
# works from a terminal inside the app, which closes with the host while the restart goes on.
# The supervisor keeps its code until it starts again (next login, or with the server down).
# Runs from Terminal.app (Login Items) because macOS blocks background agents from
# reading ~/Desktop, where the repo lives. Colima is separate: launchd starts it.
# The server runs under scripts/supervise.ts, which restarts it after a crash. Login Items and
# ~/Applications hold a symlink to this file, so the versioned copy is the one that runs.

REPO="${0:A:h:h}"
URL="http://localhost:4317"
LOG="$REPO/data/server.log"
HOST_FILE="$REPO/data/pty-host.json"
SUPERVISOR_FILE="$REPO/data/supervisor.pid"
BUN=/opt/homebrew/bin/bun

up() { curl -fsS -o /dev/null --max-time 2 "$URL/"; }
fail() {
  echo "$1"
  read -k1 "?Press a key to close"
  exit 1
}
# The pid only if it still runs the given command: a stale file never kills a stranger.
pid_running() { [[ -n "$1" ]] && ps -o command= -p "$1" 2>/dev/null | grep -q "$2"; }
wait_gone() {
  for _ in {1..40}; do kill -0 "$1" 2>/dev/null || return 0; sleep 0.25; done
  return 1
}

# The supervisor goes before the server, or it would start it again. It stops the server with it.
stop_supervisor() {
  local supervisor
  supervisor=$(cat "$SUPERVISOR_FILE" 2>/dev/null)
  if pid_running "$supervisor" "scripts/supervise.ts"; then
    echo "Stopping the supervisor ($supervisor)..."
    kill "$supervisor"
    wait_gone "$supervisor" || fail "The supervisor ($supervisor) did not stop."
  fi
}

server_pid() { curl -fsS --max-time 2 "$URL/api/health" 2>/dev/null | sed -n 's/.*"pid":\([0-9]*\).*/\1/p'; }

# 0: restarted and back; 1: refused for a reason worth stopping on; 2: use the old way (no
# supervisor, or a server from before the route).
restart_via_server() {
  local reply code body before
  reply=$(curl -sS --max-time 30 -w '\n%{http_code}' -X POST "$URL/api/system/restart" \
    -H "Origin: $URL" -H "Content-Type: application/json" -d '{"scope":"all"}' 2>/dev/null)
  code=${reply##*$'\n'}
  body=${reply%$'\n'*}
  case "$code" in
    202)
      before=$(echo "$body" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
      echo "Restarting the server and the PTY host ($before)..."
      echo "Claude, Codex and Grok sessions resume on their own; shells and env commands close."
      local now
      for _ in {1..90}; do
        sleep 1
        now=$(server_pid)
        [[ -n "$now" && "$now" != "$before" ]] && { echo "Agentic OS is running ($now)."; return 0; }
      done
      fail "Agentic OS did not come back in 90 s. Last log lines:
$(tail -20 "$LOG")"
      ;;
    409)
      [[ "$body" == *supervisor* ]] && return 2
      fail "Agentic OS refused to restart: $(echo "$body" | sed -n 's/.*"detail":"\([^"]*\)".*/\1/p')"
      ;;
    404) return 2 ;;
    *) fail "Agentic OS did not take the restart (HTTP $code): $body" ;;
  esac
}

# Stops everything by hand, for a server with no supervisor to start it again.
restart() {
  local server host
  server=$(lsof -nP -tiTCP:4317 -sTCP:LISTEN 2>/dev/null | head -1)
  host=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$HOST_FILE" 2>/dev/null)

  # Run from a terminal inside the app, this window would die with the host halfway through.
  local p=$$
  while [[ -n "$p" && "$p" != 1 ]]; do
    [[ "$p" == "$host" ]] && fail "This window runs inside Agentic OS. Run the script from Terminal.app."
    p=$(ps -o ppid= -p "$p" | tr -d ' ')
  done

  echo "Claude, Codex and Grok sessions resume on their own; shells and env commands close."
  stop_supervisor
  # The server first, so it cannot start a host of its own while the old one goes away.
  if pid_running "$server" "server/index.ts"; then
    echo "Stopping the server ($server)..."
    kill "$server"
    wait_gone "$server" || fail "The server ($server) did not stop."
  fi
  # On SIGTERM the host marks its terminals lost; the next host resumes the agents.
  if pid_running "$host" "server/host/main.ts"; then
    echo "Stopping the PTY host ($host)..."
    kill "$host"
    wait_gone "$host" || fail "The PTY host ($host) did not stop."
  fi
  return 0
}

start() {
  # The shared envctl containers live in colima; wait for it, but never block on it.
  for _ in {1..60}; do /opt/homebrew/bin/docker info >/dev/null 2>&1 && break; sleep 3; done
  /opt/homebrew/bin/docker info >/dev/null 2>&1 || echo "Colima is not ready yet; starting Agentic OS anyway."

  cd "$REPO" || fail "Repo not found: $REPO"
  # nohup: the supervisor and its server outlive this window; Terminal's access to ~/Desktop is
  # inherited.
  touch "$LOG" && chmod 600 "$LOG"
  nohup "$BUN" scripts/supervise.ts >>"$LOG" 2>&1 &
  disown

  for _ in {1..60}; do up && break; sleep 1; done
  if ! up; then
    echo "Agentic OS did not answer on $URL. Last log lines:"
    tail -20 "$LOG"
    read -k1 "?Press a key to close"
    exit 1
  fi
  echo "Agentic OS is running."
}

if up; then
  restart_via_server
  case $? in
    0) ;;
    2) restart && start ;;
    *) exit 1 ;;
  esac
else
  # A supervisor waiting to restart a crashed server would race the new one.
  stop_supervisor
  start
fi

# Remote access from the other devices needs Tailscale connected and its Serve route; a reboot
# can leave it disconnected. A failure keeps this window open; the local app runs anyway.
if ! "$BUN" "$REPO/scripts/remote-setup.ts" ensure; then
  open "$URL"
  read -k1 "?Remote access is not working (see above). Press a key to close"
  exit 1
fi

open "$URL"

# Close this window once the shell has exited (Terminal keeps it open by default).
TTY_NAME=$(tty)
nohup osascript -e "delay 1" -e "tell application \"Terminal\"
  repeat with w in windows
    if tty of selected tab of w is \"$TTY_NAME\" then close w
  end repeat
end tell" </dev/null >/dev/null 2>&1 &!
exit 0
