#!/bin/sh
# Generate the public-TLS edge config for the frontend nginx.
#
# Runs before nginx starts (via /docker-entrypoint.d/, sibling of 30-headlamp-token.sh)
# and again from 41-tls-watch.sh whenever the Let's Encrypt cert on the PVC changes.
# It always (re)writes two files, so nginx has a consistent config in every state:
#
#   /tmp/tls-redirect.conf        included inside the :80 `location /`
#   /etc/nginx/conf.d/tls.conf    the :443 server blocks (auto-included via conf.d/*.conf)
#
# States:
#   PUBLIC_TLS unset ................ both files inert -> plain :80, today's behaviour.
#   PUBLIC_TLS=letsencrypt, no cert . both files inert -> :80 serves app + ACME challenge,
#                                     so the certbot sidecar can complete HTTP-01.
#   PUBLIC_TLS=letsencrypt, cert ok . :80 `location /` 301-redirects to https; tls.conf
#                                     terminates TLS on :443 and routes by SNI/Host.
set -eu

REDIRECT=/tmp/tls-redirect.conf
TLSCONF=/etc/nginx/conf.d/tls.conf
APP="${PUBLIC_TLS_APP_HOST:-}"
LIVE="/etc/letsencrypt/live/${APP}"
CERT="${LIVE}/fullchain.pem"
KEY="${LIVE}/privkey.pem"

# Start from the inert state every run (idempotent regeneration).
printf '# public TLS off or cert not yet issued: serve the app on :80\n' > "$REDIRECT"
printf '# public TLS off or cert not yet issued: no :443 servers\n' > "$TLSCONF"

if [ "${PUBLIC_TLS:-}" != "letsencrypt" ]; then
    echo "40-tls: PUBLIC_TLS not 'letsencrypt'; serving plain :80"
    exit 0
fi
if [ -z "$APP" ]; then
    echo "40-tls: PUBLIC_TLS=letsencrypt but PUBLIC_TLS_APP_HOST is empty; serving plain :80"
    exit 0
fi
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    echo "40-tls: no cert at $CERT yet; serving app + ACME on :80, awaiting issuance"
    exit 0
fi

echo "40-tls: cert present at $CERT; emitting :443 servers and enabling the http->https redirect"
printf 'return 301 https://$host$request_uri;\n' > "$REDIRECT"

# Fresh tls.conf. `map` (http context) drives WebSocket upgrade for the proxied backends.
cat > "$TLSCONF" <<'EOF'
map $http_upgrade $tls_connection_upgrade {
    default upgrade;
    ''      close;
}
EOF

# ---- app on :443 (SPA + the shared proxy locations) --------------------------------
cat >> "$TLSCONF" <<EOF

server {
    listen 443 ssl;
    http2 on;
    server_name ${APP};

    ssl_certificate ${CERT};
    ssl_certificate_key ${KEY};

    root /usr/share/nginx/html;
    index index.html;

    location /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type "text/plain";
        try_files \$uri =404;
    }

    include /etc/nginx/snippets/app-locations.conf;

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

# ---- reverse-proxy :443 servers for the storage / registry subdomains --------------
# Each re-encrypts to the self-signed in-cluster backend (proxy_ssl_verify off), so the
# MinIO/registry manifests stay untouched. client_max_body_size 0 = unlimited (S3 object
# PUTs and docker image layer pushes).
emit_proxy() {
    _host="$1"; _upstream="$2"
    [ -z "$_host" ] && return 0
    echo "40-tls: routing https://${_host} -> ${_upstream}"
    cat >> "$TLSCONF" <<EOF

server {
    listen 443 ssl;
    http2 on;
    server_name ${_host};

    ssl_certificate ${CERT};
    ssl_certificate_key ${KEY};

    client_max_body_size 0;

    location / {
        proxy_pass ${_upstream};
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$tls_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
}

emit_proxy "${PUBLIC_TLS_S3_HOST:-}"       "https://minio.minio.svc.cluster.local:9000"
emit_proxy "${PUBLIC_TLS_CONSOLE_HOST:-}"  "https://minio.minio.svc.cluster.local:9001"
emit_proxy "${PUBLIC_TLS_REGISTRY_HOST:-}" "https://registry.registry.svc.cluster.local:5000"

echo "40-tls: wrote $TLSCONF"
