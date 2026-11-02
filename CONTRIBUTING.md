# Contributing to axon

Thanks for helping. Bug reports, fixes and improvements are all welcome. For anything larger than a
bug fix, please open an issue first, so we can agree on the approach before you spend time on code.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setting up

You need Node 22 or newer and Docker.

```bash
docker compose up -d db          # Postgres 17 + pgvector on :54329
npm install
cp .env.example .env
npm test                         # creates and uses a scratch <db>_test database
```

The tests use a deterministic fake embedder, so they never download the model. Run
`npm run axon -- serve` (or `serve --fake`) to try the server by hand.

## Before you open a pull request

```bash
npm run lint          # Biome; `npm run format` fixes most of it
npm run typecheck
npm test
```

CI runs the same checks, plus a Docker build.

- **Add a test for a behaviour change.** The README's
  [Tested invariants](README.md#tested-invariants) section lists what the suite guarantees. If you
  add a new guarantee, add it there too.
- **Run `npm run eval` if your change touches retrieval** (search, ranking, packing, thresholds or the
  embedding model), and put the before and after numbers in the PR. It uses the real model.
- **Schema changes go in a new numbered file** in `migrations/`. Never edit one that has already shipped.
- **Keep a commit to one change**, and say why in its message, not only what.
- **Update the README** when you change a tool, a REST route, a command or an environment variable.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
