# Bearer-token gateway for axon. See DEPLOY.md.
FROM caddy:2.10-alpine
COPY Caddyfile /etc/caddy/Caddyfile
# Refuse to start without a real token, rather than serving with an empty one
# (an empty AUTH_TOKEN would match the header "Bearer ").
CMD ["sh", "-c", "if [ ${#AUTH_TOKEN} -lt 32 ]; then echo 'AUTH_TOKEN must be set, 32+ characters' >&2; exit 1; fi; if [ -z \"$AXON_UPSTREAM\" ]; then echo 'AXON_UPSTREAM must be set' >&2; exit 1; fi; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
EXPOSE 8080
