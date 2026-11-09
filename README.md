# axon

[![Deploy to Gagarin Cloud](https://my.gagarin.cloud/deploy/7h9xs7d3/badge.svg)](https://my.gagarin.cloud/deploy/7h9xs7d3)

Per-project memory for AI agents. Axon stores small, durable facts about a codebase — its overview,
architecture, decisions, conventions, gotchas — and gives them back as cheaply as possible:

- **`briefing`** — one call at cold start returns a project primer packed to a token budget. Tell it what you are
  about to work on (`focus`, `paths`) and the relevant memories come first; it also lists what changed in the last 7 days.
- **`search`** — hybrid semantic + keyword search; top hits in full, the rest as one-line index entries.
- **Linked memories** — memories connect to each other like neurons. `related` walks the links, and
  links that agents actually follow get stronger over time.

Axon has an MCP server (stdio and Streamable HTTP) and a JSON REST API. Both call the same
service. There is no auth: the API is scoped by project, and v1 has no users.

## Quick start

```bash
docker compose up -d db        # Postgres 17 + pgvector on :54329
npm install
cp .env.example .env
npm run axon -- serve          # REST on http://127.0.0.1:7717/v1, MCP on /mcp
```

The first start downloads the embedding model (~600 MB) into `.models/`. Later starts load it in about a second.

### Connect an agent

Stdio, scoped to one repository (with `AXON_PROJECT` set, `project` becomes optional on every tool):

```bash
claude mcp add axon --env AXON_PROJECT=acme/api --env DATABASE_URL=postgres://axon:axon@localhost:54329/axon -- npx tsx /path/to/axon/src/cli.ts serve --stdio
```

Over HTTP, sharing one running server between projects:

```bash
claude mcp add --transport http axon http://127.0.0.1:7717/mcp
```

Suggested line for a project's `CLAUDE.md` / `AGENTS.md`:

> Project memory lives in axon (project `acme/api`). Call `briefing` before starting work, `search` before
> exploring code, and `remember` anything a future session would otherwise have to rediscover — one fact per
> memory, in English.

## Tools

| MCP tool | REST | What it does |
|---|---|---|
| `briefing` | `GET /v1/projects/:project/briefing?budget=&focus=&paths=` | Pinned + top-ranked memories in full, the rest as index lines, kind and tag overview, date of the last write. `focus` (hybrid search) or `paths` puts matching memories next after the pinned ones, under **Relevant to focus:**. **Recent (7d):** lists memories created, updated, superseded or archived in the last 7 days that aren't shown in full |
| `search` | `GET /v1/projects/:project/memories?query=&k=&kinds=&tags=&paths=&budget=` | Hybrid search; with no query, browse by rank. Adds linked neighbours of the top hits |
| `get` | `GET /v1/projects/:project/memories/:id`, `…/memories?ids=1,2&keys=deploy/current` | Full memories with their link footers, by id or key |
| `related` | `GET /v1/projects/:project/memories/:id/related?hops=&budget=` | Walk links up to 3 hops, nearest and strongest first |
| `remember` | `POST /v1/projects/:project/memories` → `201`, or `409` with the near-duplicates | Save one memory; optionally `links`, `supersedes`, `key` |
| `update` | `PATCH /v1/projects/:project/memories/:id` | Edit fields, pin, archive (`status: "archived"`), set or clear (`null`) the key, `confirm` it still holds or `dispute` it |
| `link` | `POST …/memories/:id/links {to, note}`, `DELETE …/memories/:id/links/:other` | Undirected links; no self-links, same project only |
| `review` | `GET /v1/projects/:project/review?budget=` | Housekeeping report: likely duplicates, orphans, oversized, stale, unread and disputed memories, distance to the cap |
| `list_projects` | `GET /v1/projects` | Projects with memory and link counts |
| — (REST only) | `DELETE /v1/projects/:project` | Permanently delete a project with all its memories and links |
| — (REST only) | `GET /v1/projects/:project/export?format=json\|markdown&include=active\|all` | The whole project as one JSON or Markdown document ([Export and import](#export-and-import)) |
| — (REST only) | `POST /v1/projects/:project/import` → `201` | Append an exported JSON document to a project, under new ids |

Project slugs are lowercase and may contain `/`, e.g. `acme/api`. Memory ids (`#12`) are numbered per project.
REST errors look like `{ "error": { "code", "message" } }`: `400` means invalid input, `404` not found,
`409` a duplicate or a key another memory holds, and `422` a rule violation (self-link, link cap or memory cap).
Export and import are for people and scripts rather than agents, so they have no MCP tool: tool definitions cost
tokens in every session. Budgeted REST reads also return `text`,
the same compact rendering that MCP clients get.

Memory kinds: `overview`, `architecture`, `decision`, `convention`, `gotcha`, `howto`, `reference`, `state`.

### Keys

A mutable fact ("the current deploy is v1.4", "who owns billing") can carry a `key`, e.g. `deploy/current`:
lowercase letters, digits and `. _ / : -`, up to 80 characters. A later `remember` with the same key replaces
the memory holding it exactly as `supersedes` would — no search first — and says so
(`Replaced #12 (key deploy/current); its links moved to #15.`). It is admitted at the memory cap, and passing
`supersedes` for some other memory alongside the key is refused. Superseding a keyed memory without a key
carries the key on to the successor. At most one active memory per project holds a key: `update` refuses a key
another memory holds (`409`), and so does restoring an archived memory whose key has since been taken (clear it
with `key: null` first). Archiving or superseding releases a key. `get` reads by `keys` as well as `ids`.
Full renders show the key on the metadata line (`key deploy/current · tags: …`); index lines tag it after the
title (`#15 state · Current deploy [deploy/current] · 30t`).

## How it keeps token use low

- **Every read has a budget.** The packer fits full bodies in rank order, lists the rest as index lines
  (`#12 gotcha · Stripe webhooks need the raw body · 48t ↔2`), spends any budget left over upgrading index
  lines to full bodies, and reports how many memories it left out. Output never exceeds the budget.
- **A briefing spends its budget on your task.** With a `focus` or `paths`, matching memories go right after the
  pinned ones; pinned memories then stop at 50% of the budget and matches may fill up to 80%, so the matches always
  get at least 30% in full however many pinned or high-importance memories the project holds.
- **Output is compact plain text**, not JSON, and ids are short per-project numbers.
- **Lean tool definitions.** Clients see types, enums, defaults and descriptions. Length limits and
  patterns are enforced on the server, which cut tool definitions from 1.7K to 1.1K tokens.
- **Write hygiene.** `remember` refuses near-duplicates, flags writes that likely overlap an existing
  memory, suggests links, warns about memories over 600 tokens, and warns about non-English prose (the
  embedder is multilingual, but English is cheaper in tokens).
- **A cap, if you want one.** With `AXON_MAX_MEMORIES` set, a project that holds that many active memories
  gets `422` from `remember` until something is archived or superseded — superseding is allowed at the cap,
  since it retires one memory for the one it adds. The refusal tells the agent what to do. Unset means unlimited.
  From 90% of the cap, every `remember` warns (`4,520/5,000 memories — archive or supersede what is stale; see review.`).

## Housekeeping

Memory stores rot quietly, so `review` says what needs tending, packed to a budget like any read. It lists
**likely duplicates** (pairs of active memories at or above `AXON_DEDUP_SIMILARITY − 0.1`, the same floor at
which `remember` flags likely overlaps; already-linked pairs are marked `(linked)`), **orphans** (active, unpinned,
no links to active memories, oldest first), **oversized** memories (over 600 tokens), **stale state** (`state`
memories not updated in 30 days), **unread** memories (created over 90 days ago and not read since; pinned ones
are delivered by every briefing, so they are left out) and **disputed** memories (flagged with `update dispute=true`
and neither confirmed, edited nor archived since). With `AXON_MAX_MEMORIES` set, it shows how close the project
is to the cap, with `⚠` from 80%. Empty sections are left out, and a tidy project gets `Nothing to tidy in …`.
The duplicate check looks up the 3 nearest neighbours of each of the first 500 active memories through the
HNSW index, so a review costs at most 1,500 index lookups however large the project grows. Review is read-only:
the fixes are ordinary `remember supersedes=`, `link`, `update` and archive calls.

## Freshness

Memories age. Each one records when it was last **confirmed** true (`confirmedAt`): when it was written, when
its title or body was edited (editing asserts it is true), or when an agent or a human sent `update confirm=true`.
`update dispute=true` flags it as probably wrong (`disputedAt`) until it is confirmed or edited; the answer says
how to resolve it — fix it with `update`, replace it with `remember supersedes=<id>`, or archive it. Archiving
leaves both flags alone, and superseded memories can be neither confirmed nor disputed. A dispute has no
free-text note, so it adds nothing for encryption to cover.

- **Ranking.** A briefing scales each memory's score by its freshness: it halves every 30 days unconfirmed for
  `state`, 180 days for `gotcha`, `howto` and `reference`, and 365 days for everything else, but never drops
  below 0.4, so old facts sink without vanishing. A disputed memory's score is halved and it sorts after every
  undisputed memory with the same pin status. Search keeps its relevance order, so a disputed memory can still
  be found.
- **Markers.** A disputed memory reads `#12 gotcha · Stripe webhooks need the raw body ⚠ disputed · 48t`, and
  every full memory shows `confirmed YYYY-MM-DD` (and `disputed YYYY-MM-DD`). Index lines of `state` memories
  unconfirmed for over 60 days, and `gotcha` memories for over 180, end with `· unconfirmed 140d`. A briefing
  with disputed memories in its pool adds `⚠ 2 disputed memories (#4, #9) — confirm, fix or archive them`.

## Links

Links are undirected. The database enforces canonical `a < b` ordering, so there are no self-links and
no duplicate pairs, and composite foreign keys prevent links across projects. Each memory can have at
most 32 links.

- Each full memory ends with a footer listing its strongest links: `↔ #12 Auth token format · #31 Session TTL (+3)`.
- `related` is a breadth-first walk (a recursive CTE). It returns each memory once, at its shortest hop,
  through the strongest path, and skips archived and superseded memories.
- **Hebbian weights.** Following a link with `related`, or reading both ends with one `get`, strengthens
  the link. Extra weight decays with a 60-day half-life, so paths agents use often come first.
- `search` also lists the strongest neighbours of its top hits under **Linked:**.
- Superseding a memory moves its links to the successor.

## Export and import

`GET /v1/projects/:project/export` (or `axon export <project>`) returns the whole project, decrypted, in one
document. It is not budgeted, and it doesn't count as a read: access counters and link strengths are left alone.

- **`format=json`** (the default) is the canonical, importable form:

  ```json
  {
    "axon": { "version": "0.1.0", "format": 1 },
    "project": "acme/api",
    "exported_at": "2026-10-26T12:00:00.000Z",
    "memories": [
      { "seq": 12, "kind": "gotcha", "title": "…", "body": "…", "tags": [], "paths": [], "pinned": false,
        "importance": 3, "status": "active", "superseded_by": null, "source": null, "key": null,
        "created_at": "…", "updated_at": "…", "confirmed_at": "…", "disputed_at": null }
    ],
    "links": [{ "a": 3, "b": 12, "note": "same webhook", "weight": 1.25 }]
  }
  ```

  Memories are in seq order; links are undirected (lower seq first), and `weight` is the link's current strength.
- **`format=markdown`** is for reading or ejecting: a title line with the project, date and counts, then each memory
  as `## #12 gotcha · Title` with its metadata as a list and its complete body, then a `## Links` section.
- **`include=active`** leaves out archived and superseded memories and every link that touches one. The default,
  `all`, is a full backup.
- Not included: embeddings (they only mean something to the model that made them), token counts, access counters,
  and when links were created or last followed.

`POST /v1/projects/:project/import` (or `axon import <project> [file]`, reading stdin without a file) takes the JSON
document and **appends** it to the project, creating the project if needed. It is a restore, not a merge:

- Every memory gets a new id, and links and `superseded_by` are renumbered to match. The response maps old ids to
  new: `{ "imported": 4, "links": 3, "mapping": { "1": 13, "2": 14, … } }`.
- Kind, text, tags, paths, pinning, importance, status, source, key, confirmation and dispute dates and both
  timestamps are kept. Links keep their note, and start at their exported strength.
- A key that an active memory of the target already holds is a `409` and nothing is written: an import restores,
  it does not replace. Two active memories holding one key in the document are refused as invalid.
- Every memory is re-embedded with the current model and its tokens recounted, so a document moves between
  instances running different models.
- Near-duplicates are not refused, so importing the same file twice gives you two copies.
- The memory cap applies to the batch: if the active memories it adds would take the project past
  `AXON_MAX_MEMORIES`, the import is refused with `422` and nothing is written. So is a memory with more links than
  `AXON_MAX_LINKS`. The import runs in one transaction, holding the project's lock against concurrent writes.
- The document is checked before anything is written: an unknown `format`, a link or `superseded_by` naming a seq
  that isn't in the document, a bad kind or status, or anything over `remember`'s limits (title 120 characters,
  body 16,000, 12 tags, 20 paths) is refused with `400`, naming the field.

With encryption on, the export holds plaintext (any read decrypts), so treat the file like the key. An import is
stored in the server's current mode: encrypted with `AXON_ENCRYPTION_KEY` if it is set, whatever mode the source
used. To move memory between instances, export from one and import into the other; the keys never need to match.

## Storage and retrieval

Everything lives in Postgres with pgvector. Memories, links and vectors are written in one transaction,
and hybrid search is a single query. The vector lane uses HNSW with an iterative scan for filtered recall.
The keyword lane uses `tsvector` with the `simple` config, so exact identifiers match. The two lanes are
merged with reciprocal rank fusion (k = 60). Vector-only hits below `AXON_SEARCH_MIN_SIMILARITY` are dropped.

The embedding column is not typed with a dimension, and the HNSW index is an expression index for the
configured model's dimension. So switching models means running `axon reembed`, not a schema migration.
The database records which model built it, and the server refuses to start under a different one.

### Embedding model

The default model is **Qwen3-Embedding-0.6B** (Apache-2.0, multilingual, 1024 dimensions, 32K context), run
locally as q8 ONNX through transformers.js. It needs no API keys. On an Apple-silicon laptop CPU, an embedding
takes about 40–80 ms and the model loads in about 1.2 s.

Results from `npm run eval` on the bundled golden set (25 memories, 35 queries):

| category | n | R@1 | R@5 | MRR@10 |
|---|---|---|---|---|
| paraphrase | 16 | 94% | 100% | 0.969 |
| identifier | 9 | 100% | 100% | 1.000 |
| cross-lingual (uk, de, es, ja, fr → English memories) | 7 | 86% | 100% | 0.929 |

Qwen3's cosine scores are compressed: a paraphrase of the same fact scores about 0.88, a different fact on the
same topic about 0.6, and unrelated text about 0.25–0.38. The default thresholds are set for that. After
switching models (`AXON_EMBED_MODEL`, then `axon reembed`), run `npm run eval` again and adjust them.

## Encryption

Set `AXON_ENCRYPTION_KEY` (32 bytes, base64: `openssl rand -base64 32`) and the server encrypts each memory's
**title, body and source** with AES-256-GCM before it reaches Postgres. Every row records whether it is encrypted
(`memories.encrypted`), so plaintext and encrypted memories can live side by side:

- With the key set, new memories are encrypted, and editing a plaintext memory's text encrypts it.
  Without it, writes are plaintext.
- `axon encrypt` encrypts every existing memory; `axon decrypt` turns them all back into plaintext (unset the
  key afterwards). Both can be re-run safely.
- The database records a fingerprint of the key. The server refuses to start with a different key, or with no key
  while encrypted memories exist. **Losing the key means losing the text.**
- Ciphertext is bound to its project and field, so it can't be copied into another project or column.

### Rotating the key

`axon rotate-key` re-encrypts every encrypted memory from the current key to a new one in a single transaction,
without ever writing the text back as plaintext. It is an offline operation: it locks the `memories` table and
takes seconds on a normal database.

1. Back up first — `pg_dump` — and keep the backup until the new key is safely stored.
2. Generate the new key: `openssl rand -base64 32`.
3. Stop **every** axon process: the HTTP server and any stdio MCP servers your agents have spawned.
4. `AXON_ENCRYPTION_KEY=<old> AXON_ENCRYPTION_KEY_NEW=<new> npm run axon -- rotate-key`
5. Set `AXON_ENCRYPTION_KEY` to the new key, unset `AXON_ENCRYPTION_KEY_NEW`, and start axon again.
6. Retire the old key — but keep it as long as backups taken before the rotation still need to be readable.

Either the whole rotation commits or nothing does: an interrupted run, a wrong current key, or a row that fails
to decrypt leaves every memory on the old key, so the database is never half-rotated. Re-running after a
successful rotation is a no-op. A process that missed step 3 can't do damage either — it is refused at startup
(wrong fingerprint) and, if it was already running, its next write to a memory's text fails rather than storing
rows the new key couldn't read.

What stays in plaintext: kind, tags, paths, keys, link notes, token counts and timestamps (for filters, stats and ranking),
and the **embeddings**. Embeddings are needed for vector search, and they do reveal roughly what a memory is about.
Postgres can't index ciphertext, so the keyword lane matches encrypted memories only on their tags and paths. Their
text is found by semantic search alone, so exact identifiers are harder to find.

## Commands

```bash
npm run axon -- serve [--stdio]   # HTTP (REST + MCP) or MCP over stdio; migrates on start
npm run axon -- migrate
npm run axon -- reembed           # after changing AXON_EMBED_MODEL
npm run axon -- encrypt           # encrypt every memory with AXON_ENCRYPTION_KEY (decrypt: the reverse)
npm run axon -- rotate-key        # re-encrypt from AXON_ENCRYPTION_KEY to AXON_ENCRYPTION_KEY_NEW
npm run axon -- export acme/api [--format json|markdown] [--active] > acme-api.axon.json
npm run axon -- import acme/api [acme-api.axon.json]   # or pipe the document on stdin; prints the id mapping
npm run axon -- warmup            # download/load the model only
npm run eval                      # retrieval quality, in a scratch <db>_eval database
npm test                          # unit + integration tests, in a scratch <db>_test database
npm run test:coverage             # the same, with a coverage report (coverage/index.html)
npm run lint && npm run typecheck
```

Docker: `docker build -t axon .` builds a ~2 GB image with the model baked in, so containers start
offline (the model loads in ~6 s under Docker Desktop on macOS). It serves on `0.0.0.0:7717` with no auth,
so put it behind something that authenticates before exposing it anywhere.
Every commit to `main` also publishes the image to Docker Hub, with a signed provenance attestation
(see [DEPLOY.md](DEPLOY.md#the-images)).
[DEPLOY.md](DEPLOY.md) runs it on [Gagarin](https://gagarin.cloud), privately or behind a bearer-token gateway.

## Tested invariants

`npm test` runs against real Postgres + pgvector with a deterministic fake embedder:

- **Isolation** — ids are per project and gapless under concurrent writes; nothing reads or links across projects.
- **Budgets** — briefing (with or without a focus), search and related output never exceeds `budget_tokens`;
  pinned memories come first.
- **Retrieval** — exact identifiers hit via the keyword lane; kind/tag/path filters; archived and superseded
  memories never appear in search, link walks or a briefing's ranked memories (only in its Recent list, marked as such).
- **Briefings** — a low-importance memory matching the `focus` or `paths` is shown in full where it otherwise
  wouldn't be, even next to pinned memories that would fill the budget; Recent marks each change as new, updated,
  superseded by #N or archived, skips memories shown in full and changes older than 7 days, and replaces a memory's
  line under More: rather than repeating it.
- **Writes** — near-duplicates are refused unless forced; failed writes leave nothing behind; updates
  re-embed only when text changes; superseded memories can't be revived.
- **Freshness** — new memories count as confirmed when written (and migration 0004 backfills from `created_at`);
  `confirm` and title/body edits reset the age and clear a dispute, other edits and archiving don't; confirm and
  dispute together are refused, as is either on a superseded memory or on another project's id; an old `state`
  ranks below a fresh one and a disputed memory below an undisputed one, and both are marked wherever they render.
- **Keys** — one active holder per key and project (in the service and a partial unique index); a keyed write
  replaces the holder and moves its links, also at the cap; concurrent writers of one new key form a single chain
  rather than colliding; taking or restoring into a held key is a `409` that writes nothing; keys never cross projects.
- **Links** — no self-links and no cross-project links (checked in both the service and the database schema);
  undirected and idempotent; per-memory cap enforced on both ends; walks visit each memory once through cycles;
  traversal strengthens links and extra strength decays with a 60-day half-life; supersede moves links.
- **Model binding** — a database refuses a different embedding model until `reembed` switches it over.
- **Encryption** — encrypted rows hold no plaintext text and read back intact, mixed rows coexist, a wrong or
  missing key is refused, ciphertext is bound to its project and field, and `encrypt`/`decrypt`/`reembed` work
  across the whole database.
- **Key rotation** — `rotate-key` rewrites every encrypted row and rebinds the database; a failure part-way
  rolls back to the old key entirely, and a server left on the old key can no longer write memory text.
- **Review** — each section finds what it should and nothing else (linked and pinned memories are not orphans,
  pinned or recently read ones are not unread, archived and superseded ones never appear, a disputed memory is
  listed until it is confirmed, edited or archived); empty sections are omitted; a tidy project gets the all-clear; output never exceeds `budget_tokens`; a review of one project never
  lists another's memories, not even as half of a duplicate pair. The cap line flags `⚠` from 80%, and `remember`
  warns from 90% of the cap but not below.
- **Export and import** — a JSON round trip into another project reproduces every field, link (note and
  strength) and supersession under remapped ids, and the copy is re-embedded and searchable; Markdown holds every
  complete body and the links; `include=active` drops retired memories and their links; an export never contains
  another project's memories or links, and importing leaves the source untouched; an import past the memory cap
  (including two racing imports) or with an invalid document writes nothing; encrypted servers export plaintext and
  import as ciphertext; keys, confirmation and dispute dates travel with the memory, and a key the target already
  holds refuses the whole import.
- **Transports** — REST status codes, MCP tools over Streamable HTTP (including the default project),
  server-side validation of limits not advertised to clients, export, import and delete routing for slugs that
  contain `/` or end in `/export` or `/import`, the `export`/`import` CLI, DNS-rebinding protection, and `/healthz`
  failing with 503 (and no connection details in the body) when the database is unreachable.

## Layout

```
src/core      AxonService (transport-agnostic facade) over one module per use case: briefing,
              reads, remember, writes, review, transfer; plus ranking, token packing, rendering, input schemas
src/store     PgStore — all SQL: hybrid search, link walk, Hebbian reinforcement; content codecs
              (plaintext / encrypted), database bindings, whole-database maintenance queries
src/maintenance.ts  reembed, encrypt/decrypt and rotate-key, run by the CLI
src/embed     Embedder interface, transformers.js (Qwen3) and a deterministic fake for tests
src/mcp       MCP tools over AxonService
src/http      Hono app: REST /v1 and MCP /mcp
migrations    SQL migrations
eval          golden set for `axon eval`
deploy        a bearer-token gateway for running axon on Gagarin (see DEPLOY.md)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
