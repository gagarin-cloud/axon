# Deploying axon to Gagarin

This guide runs axon on [Gagarin](https://gagarin.cloud), with a managed Postgres and, if you want to
reach it from outside the project, a bearer-token gateway in front of it.

Axon has **no authentication of its own**: anything that can reach its port can read and write every
project's memories. So there are two ways to run it, and the difference is who can reach it:

| | Who reaches axon | Public address | Cost (approx.) |
|---|---|---|---|
| **A. Private** | only services in the same Gagarin project that declare it | none | ~$40/month |
| **B. Behind the gateway** | anyone holding the token, over HTTPS (agents on your laptop, CI) | the gateway's | ~$50/month |

Never run `gg domain add` on the axon service itself. Give an address only to the gateway.

## What you need

- The `gg` CLI, logged in: see the [Gagarin quick start](https://gagarin.cloud/llms.txt)
  (`curl -fsSL https://gagarin.cloud/install.sh | sh`, then `gg login`).
- `openssl`, to generate keys.

The commands below use a project called `axon`. Use your own name, and the project's id if you have
several with the same name.

## The images

Every commit to `main` publishes two images to Docker Hub. There is nothing to build:

| Image | What it is |
|---|---|
| `docker.io/gagarincloud/axon` | the server, with the embedding model baked in (~2 GB), so it starts offline |
| `docker.io/gagarincloud/axon-gateway` | the bearer-token gateway from [`deploy/gagarin/gateway`](deploy/gagarin/gateway) |

Each has `:sha-<commit>`, which is never overwritten, and `:latest`. Pick a `sha-` tag, so you know exactly
which commit you run. The [publish workflow's runs](https://github.com/gagarin-cloud/axon/actions/workflows/publish.yml) list each commit's
digest.

Each image carries a signed provenance attestation. To check that an image was built by this
repository's workflow, from the commit its tag names, and from nothing else, run:

```bash
gh attestation verify oci://docker.io/gagarincloud/axon:sha-<commit> --repo gagarin-cloud/axon
```

Gagarin runs only images in a project's own registry, so the first step below copies the image in.

## What gets created

| Name | Kind | Size | What it is |
|---|---|---|---|
| `database` | postgres | s | Postgres 17 with pgvector. Its name makes it publish `DATABASE_URL`, which axon reads as is |
| `axon` | external | none | Axon settings, published as `AXON_*`: `ENCRYPTION_KEY` becomes `AXON_ENCRYPTION_KEY` |
| `server` | service | **m** | Axon itself, on :7717, private |
| `auth` | external | none | *B only.* `TOKEN`, published as `AUTH_TOKEN` |
| `gateway` | service | s | *B only.* Caddy on :8080, checks the token and proxies to `server`, public |

The server is size `m` (2 GB) because the Qwen3 embedding model takes most of a gigabyte in memory.
At size `s` it can be OOM-killed under load.

## A. Private axon

Run these from the repository root.

```bash
gg init axon

# 1. The database, with pgvector (which postgres calls `vector`).
gg resource add axon/database postgres --storage 10 --ext vector

# 2. Settings and the encryption key, as an external so they are never pasted into a deploy.
#    Keep a copy of the key somewhere safe: without it, encrypted memories cannot be read.
umask 077
printf 'ENCRYPTION_KEY=%s\nMAX_MEMORIES=5000\n' "$(openssl rand -base64 32)" > .env.axon
gg resource add axon/axon external --env-file .env.axon

# 3. Copy the image in, then run it, holding both. Migrations run on start.
AXON_TAG=sha-<commit>                      # see "The images" above
gg registry copy axon/axon:$AXON_TAG docker.io/gagarincloud/axon:$AXON_TAG
gg deploy axon/server:7717 axon:$AXON_TAG --size m --deps database --deps axon

# 4. Is it up?
gg status axon
gg logs axon/server        # "[axon] listening on http://0.0.0.0:7717"
```

`.gitignore` already ignores `.env.*` files like this one. Once the key is stored somewhere safe
(a password manager), delete the file.

Any other service in the project now reaches axon by name, once it declares the edge:

```bash
gg deps add axon/<your-service> server   # then call http://server:7717/mcp or /v1
```

Until then its calls are dropped and hang: Gagarin's network denies by default.

## B. Behind the gateway

Do everything in A first, then:

```bash
# 1. The token clients will send.
umask 077
printf 'TOKEN=%s\n' "$(openssl rand -hex 32)" > .env.auth
gg resource add axon/auth external --env-file .env.auth

# 2. The gateway, which may reach the token and axon.
gg registry copy axon/axon-gateway:$AXON_TAG docker.io/gagarincloud/axon-gateway:$AXON_TAG
gg deploy axon/gateway:8080 axon-gateway:$AXON_TAG \
  --env AXON_UPSTREAM=http://server:7717 --deps auth --deps server

# 3. A public HTTPS address, for the gateway only.
gg domain add axon/gateway
```

`gg domain add` prints the address, something like `https://gateway-<project-id>.fr-par-1.apps.gagarin.cloud`.
To use your own hostname, run `gg domain add axon/gateway memory.example.com` and create the DNS record it prints.

Connect an agent:

```bash
claude mcp add --transport http axon https://<address>/mcp \
  --header "Authorization: Bearer $(sed -n 's/^TOKEN=//p' .env.auth)"
```

The REST API is under the same address: `curl -H "Authorization: Bearer <token>" https://<address>/v1/projects`.

What the gateway does ([`deploy/gagarin/gateway/Caddyfile`](deploy/gagarin/gateway/Caddyfile)):

- It answers `401` unless the request carries exactly `Authorization: Bearer <AUTH_TOKEN>`.
- It strips the `Authorization` header before passing the request to axon.
- It leaves `/healthz` open. That only says whether axon and its database are up.
- It refuses to start if `AUTH_TOKEN` is shorter than 32 characters, or if `AXON_UPSTREAM` is unset.

One token means one level of access: whoever holds it can read and write **every** project on this
axon. Give each team or trust boundary its own deployment, not a shared token. If public MCP clients
(such as Claude's connector directory) need OAuth, put an OAuth proxy in the gateway's place. The
gateway is the only piece you swap out.

## Day two

**Upgrade:** copy the newer tag in, then deploy it. Dependencies, size and settings stay as they are.
The deploy replaces the environment, so restate any `--env` it had: the server has none, and the
gateway has `AXON_UPSTREAM`.

```bash
AXON_TAG=sha-<newer commit>
gg registry copy axon/axon:$AXON_TAG docker.io/gagarincloud/axon:$AXON_TAG
gg deploy axon/server:7717 axon:$AXON_TAG
```

`gg rollback axon/server` puts the previous image back.

**Running your own changes:** build from a clone instead of copying. `gg ship axon/server:7717` builds the
Dockerfile in the current directory, pushes it into the project and runs it. `gg ship axon/gateway:8080
--context deploy/gagarin/gateway --env AXON_UPSTREAM=http://server:7717` does the same for the gateway.
It needs Docker running, and the server image is ~2 GB.

**Change a setting** such as `MAX_MEMORIES` without a redeploy:
`gg resource rotate axon/axon --set MAX_MEMORIES=10000`. The server restarts holding the new value.
Any `AXON_*` variable from [`.env.example`](.env.example) works this way, minus the `AXON_` prefix.

**Rotate the gateway token:** write a new `.env.auth`, then `gg resource rotate axon/auth --env-file .env.auth`.
The gateway restarts with it, and every client needs the new token.

**Do not change `ENCRYPTION_KEY` with `gg resource rotate`.** The database is bound to the key that
encrypted it, so a server started with a different key refuses to serve. Rotate it with axon itself,
from your machine, through a tunnel:

```bash
gg connect axon/database            # leave it running; it prints a local DATABASE_URL
# in another terminal, from this repository:
DATABASE_URL=<printed URL> AXON_ENCRYPTION_KEY=<current> AXON_ENCRYPTION_KEY_NEW=<new> \
  npm run axon -- rotate-key
gg resource rotate axon/axon --set ENCRYPTION_KEY=<new>
```

Between the rotation and the restart, the running server can still read memories but can no longer
write them. See [Encryption](README.md#encryption).

**Back up or move a project:** Gagarin backs up the database nightly and keeps 14 days
(`gg resource restore`). For a portable copy, open the same tunnel and run
`npm run axon -- export <project> > <project>.axon.json`.

## If something is wrong

- **The server fails on start with an error about `CREATE EXTENSION vector`** (not available, or
  permission denied). The database was created without pgvector, and axon's user can't add it itself. Restate it with the extension: `gg resource add axon/database postgres --ext vector`.
  That takes effect immediately, with no restart. Then restart the server by deploying its current tag again: `gg deploy axon/server:7717 axon:$AXON_TAG`.
- **Calls to axon hang.** Something is missing a dependency. `gg status axon` lists what each service
  reaches. The gateway needs `server`, and your own services need `server`.
- **The server restarts with `OOMKilled`.** It is running at size `s`. Run `gg deploy axon/server:7717 axon:$AXON_TAG --size m`.
- **Every call through the gateway answers 401.** Either the header is missing or the token differs. The format
  is `Authorization: Bearer <token>`, with exactly one space.
- **The gateway exits immediately.** `gg logs axon/gateway` names the variable. Usually the deploy left out
  `--deps auth`, or `--env AXON_UPSTREAM=...`.
