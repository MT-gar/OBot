#!/usr/bin/env bash
set -euo pipefail
role="${APP_ROLE:-p0}"
prepare_home() {
  install -d -o desktop -g desktop /home/desktop/Workspace /home/desktop/.private-computer /home/desktop/.config
  chown desktop:desktop /home/desktop
  chown -R desktop:desktop /home/desktop/Workspace /home/desktop/.private-computer /home/desktop/.config
}
case "$role" in
  control)
    test -s /run/secrets/owner-password
    test -s /run/secrets/runner-token
    install -d -m 0700 -o desktop -g desktop /run/private-computer /var/lib/private-computer /workspace
    install -m 0400 -o desktop -g desktop /run/secrets/owner-password /run/private-computer/owner-password
    install -m 0400 -o desktop -g desktop /run/secrets/runner-token /run/private-computer/runner-token
    if [[ -f /run/secrets/model-key ]]; then install -m 0400 -o desktop -g desktop /run/secrets/model-key /run/private-computer/model-key; fi
    chown desktop:desktop /var/lib/private-computer /workspace
    export OWNER_PASSWORD_FILE=/run/private-computer/owner-password
    export RUNNER_TOKEN_FILE=/run/private-computer/runner-token
    export MODEL_API_KEY_FILE=/run/private-computer/model-key
    exec gosu desktop node /opt/private-computer/apps/control/src/server.mjs
    ;;
  desktop)
    if [[ -e /run/secrets/model-key || -e /run/secrets/owner-password ]]; then
      echo 'Desktop must not be mounted with model or owner credentials.' >&2; exit 1
    fi
    test -s /run/secrets/runner-token
    prepare_home
    install -d -m 0700 -o runner -g runner /run/private-runner
    install -m 0400 -o runner -g runner /run/secrets/runner-token /run/private-runner/token
    export RUNNER_TOKEN_FILE=/run/private-runner/token
    children=()
    cleanup() { trap - EXIT TERM INT; for child in "${children[@]}"; do kill "$child" 2>/dev/null || true; done; wait 2>/dev/null || true; }
    trap cleanup EXIT TERM INT
    gosu desktop /usr/local/lib/private-computer/session.sh &
    children+=("$!")
    gosu runner node /opt/private-computer/apps/desktop/server.mjs &
    children+=("$!")
    wait -n "${children[@]}"
    exit 1
    ;;
  egress)
    if [[ -e /run/secrets/model-key || -e /run/secrets/owner-password || -e /run/secrets/runner-token ]]; then
      echo 'Egress proxy must not be mounted with application credentials.' >&2; exit 1
    fi
    exec gosu desktop node /opt/private-computer/apps/desktop/egress.mjs
    ;;
  p0)
    test -s /run/secrets/owner-password
    install -d -m 0700 -o desktop -g desktop /run/private-computer
    install -m 0400 -o desktop -g desktop /run/secrets/owner-password /run/private-computer/owner-password
    export OWNER_PASSWORD_FILE=/run/private-computer/owner-password
    prepare_home
    exec gosu desktop /usr/local/lib/private-computer/session.sh
    ;;
  *) echo 'Unknown private-computer role.' >&2; exit 1 ;;
esac
