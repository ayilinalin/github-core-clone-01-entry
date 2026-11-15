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
  updates, unpack reports). Objects are stored verbatim as pushed, so a
  clone round-trips byte-exactly.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents,
  issues, comments, pull requests, labels, git refs. Every reply carries a
  non-empty `X-GitHub-Request-Id`.
- **GraphQL** at `/api/graphql`: a small parser and executor for the
  documents the suite sends (repository/issue/pullRequest, connections,
  mutations, `__type` introspection).
- **MCP** at `/mcp`: streamable HTTP JSON-RPC with `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request`.

## Determinism

Every timestamp comes from `MAKEFUN_TRIAL_NOW` (RFC 3339 or epoch
milliseconds); request ids are a counter, never random. The token owner is
the contest scenario's viewer, derived from the fixed seed with the same
seeded RNG the suite uses. All state is in memory.

## v2 (perf-only)

v2 keeps every feature and agent behavior identical and optimizes only the
hot paths: cached timestamps, streaming sha1, a direct-parent fast path
for fast-forward checks, a cached serialized issue JSON for single-issue
GETs, cached upload-pack fetch and ls-refs replies (objects are immutable,
so the caches are exact), a constant v2 advertisement, and TCP_NODELAY on
accepted sockets.
