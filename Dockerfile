# Stock Caddy + per-IP rate limiting. Versions pinned.
FROM caddy:2.11.9-builder AS builder
RUN xcaddy build v2.11.9 --with github.com/mholt/caddy-ratelimit@v0.1.0

FROM caddy:2.11.9-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# Only high ports are used: drop the bind-privileged-ports file capability, which can't
# be honoured in a container running without capabilities (cap_drop: ALL).
RUN apk add --no-cache libcap-utils && setcap -r /usr/bin/caddy && apk del libcap-utils
