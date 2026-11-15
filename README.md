# github-core-clone-01-entry

A standalone GitHub-compatible git forge in a single Node process. No
dependencies, no git binary, no network at run time: the Node standard
library only.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the trial lifecycle (bind an ephemeral port, register it with
`$MAKEFUN_ENV_URL`, poll `/done`, exit 0). `app.ts` is the forge itself.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git`: `upload-pack` protocol v2
  (advertisement, `ls-refs`, `fetch` with shallow/deepen and incremental
  `have` handling) and `receive-pack` protocol v0 (fast-forward-only ref
  updates, per-ref `report-status` over sideband).
- **REST v3** under `/api/v3`: repositories, branches, commits, contents,
  issues, comments, labels, pull requests (files, squash merge with
  conflict detection), Git Data refs.
- **GraphQL** at `/api/graphql`: the documents `gh` and
  `github-mcp-server` send — viewer, repository, issues, pull requests,
  mutations, `node(id:)`, introspection, operation batching.
- **MCP** at `/mcp`: streamable HTTP JSON-RPC, `server/discover` and the
  legacy `initialize` handshake, six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`).

## Design

- Everything is in memory. Objects are stored verbatim as pushed, so a
  clone round-trips byte-exactly. Packs are plain (no deltas); SHA-1 ids
  are recomputed from `type + size + data`.
- The token owner is the scenario's viewer, derived from the contest's
  fixed seed with the same seeded RNG the suite uses (`adaiversen`).
  A repository under any other owner is a 404, never a 403.
- Determinism: every timestamp comes from `MAKEFUN_TRIAL_NOW` (RFC 3339
  or epoch milliseconds); request ids are a counter, never random.
  The same request sequence always yields the same answers.

## Layout

- `main.ts` — lifecycle, nothing else.
- `app.ts` — the whole forge: store, git codecs, REST, GraphQL, MCP.
