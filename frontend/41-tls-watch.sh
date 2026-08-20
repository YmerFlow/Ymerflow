#!/bin/sh
# Background watcher: poll the Let's Encrypt cert on the shared PVC and, when it first
# appears (initial issuance by the certbot sidecar) or changes (renewal), regenerate the
# TLS config via 40-tls.sh and reload nginx. Self-contained in the nginx container — no
# shared PID namespace, no cross-container coupling; the certbot sidecar only ever writes
# to the PVC.
#
# Runs from /docker-entrypoint.d/ like its siblings, so it must return promptly: it forks
# the poll loop into the background and exits. The loop is reparented to nginx (PID 1)
# after the entrypoint `exec`s nginx and keeps running for the life of the container.
[ "${PUBLIC_TLS:-}" = "letsencrypt" ] || exit 0
[ -n "${PUBLIC_TLS_APP_HOST:-}" ] || exit 0

CERT="/etc/letsencrypt/live/${PUBLIC_TLS_APP_HOST}/fullchain.pem"

(
    # Seed with the current state so an already-issued cert (redeploy) does not trigger a
    # spurious reload right after startup — 40-tls.sh already emitted :443 in that case.
    last="$(stat -c %Y "$CERT" 2>/dev/null || echo none)"
    while true; do
        sleep 30
        cur="$(stat -c %Y "$CERT" 2>/dev/null || echo none)"
        if [ "$cur" != "$last" ]; then
            echo "41-tls-watch: cert change detected (was=$last now=$cur); regenerating config"
            /docker-entrypoint.d/40-tls.sh || echo "41-tls-watch: 40-tls.sh failed"
            if nginx -t 2>/dev/null; then
                nginx -s reload && echo "41-tls-watch: nginx reloaded"
            else
                echo "41-tls-watch: nginx config test failed; keeping previous config"
            fi
            last="$cur"
        fi
    done
) &

echo "41-tls-watch: started background cert watcher (pid $!) on $CERT"
