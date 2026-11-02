# Security policy

## Reporting a vulnerability

Please don't report security problems in public issues, pull requests or discussions.

Report them privately through GitHub instead: open the repository's **Security** tab and choose
**Report a vulnerability**. Only the maintainers see the report.

Please include:

- what an attacker can do, and what they need first (network access, a token, a crafted memory)
- steps or a proof of concept that reproduce it
- the axon version or commit you tested

You should hear back within 5 working days. Once the problem is confirmed, we'll agree a disclosure
date with you, credit you in the release notes if you'd like, and publish an advisory alongside the fix.

## Supported versions

Axon has not reached 1.0. Fixes go to the latest release on `main` only.

## What axon does and does not protect

Some behaviour is by design. Please read this section before reporting.

- **There is no authentication.** Anything that can reach the HTTP port can read, write, export and
  delete every project. By default axon binds to `127.0.0.1`, and on loopback it rejects foreign
  `Host`/`Origin` headers to guard against DNS rebinding. Bind it anywhere else only behind something
  that authenticates. [DEPLOY.md](DEPLOY.md) has a bearer-token gateway for this. "Unauthenticated
  access to a server exposed without a gateway" is therefore not a vulnerability. A way past the
  loopback checks or past the gateway is.
- **Projects are a namespace, not a security boundary.** Any client that can reach axon can name any
  project. A memory or link that crosses projects through the API, though, is a bug: please report it.
- **Encryption at rest** (`AXON_ENCRYPTION_KEY`) covers memory title, body and source. Tags, keys,
  kinds, paths, timestamps, link graphs and embeddings stay readable, and embeddings can leak something
  about the text. Whoever holds the key and database access can read everything. Ciphertext that
  decrypts under the wrong project or field, or plaintext stored while encryption is on, is a bug.
- **Memories are untrusted input to the agents that read them.** Anyone who can write memories can
  write text that tries to steer an agent (prompt injection). Axon stores and returns that text as is.
- **Error messages.** REST and MCP should never return database hosts, users or SQL in an error. A
  response that does is a bug.
