FROM node:22 AS build

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY snippets/app-locations.conf /etc/nginx/snippets/app-locations.conf
COPY 30-headlamp-token.sh /docker-entrypoint.d/30-headlamp-token.sh
# Public-TLS edge (all inert unless PUBLIC_TLS=letsencrypt is set at runtime — see 40-tls.sh):
# 40-tls.sh generates the :443 server blocks from the cert on the mounted PVC; 41-tls-watch.sh
# reloads nginx when that cert appears/renews. /var/www/acme is the HTTP-01 webroot shared
# (emptyDir) with the certbot sidecar.
COPY 40-tls.sh /docker-entrypoint.d/40-tls.sh
COPY 41-tls-watch.sh /docker-entrypoint.d/41-tls-watch.sh
RUN chmod +x /docker-entrypoint.d/30-headlamp-token.sh \
             /docker-entrypoint.d/40-tls.sh \
             /docker-entrypoint.d/41-tls-watch.sh \
    && mkdir -p /var/www/acme
EXPOSE 80 443
