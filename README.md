# github-core-clone-01-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ayilinalin/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/ayilinalin/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)

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

## v3 (perf-only)

v3 keeps every feature and agent behavior identical and optimizes only the
per-request overhead the v2 profile exposed (the git workloads were
dominated by request handling, not crypto): upload-pack bodies are parsed
straight from the request buffer into strings (no per-line Buffer copy, no
Pkt objects); ls-refs and the v0 advertisement are cached per (repo,
ref-version, default-branch, args) instead of re-running sortedRefs and
stringifying the ref list on every request; the fetch cache key is a string
concatenation and carries the object-store version; pkt-line replies are
framed as one string and turned into a Buffer once; the request path is
parsed by hand instead of `new URL` per request; the cached issue JSON is
stored as bytes; the fast-forward direct-parent check scans commit bytes
instead of splitting the whole object; parsePack uses inflateSync's output
buffer directly instead of copying it.
