# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/wangzze460-lgtm/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/wangzze460-lgtm/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, standard library only. It serves real git smart HTTP (upload-pack v2 and receive-pack v0), the REST v3 API, GraphQL v4, and MCP — all from one in-memory store, no git binary, no external service.

## Run it

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port, registers it with the harness through `$MAKEFUN_ENV_URL`, and serves until the harness says it is done. Node 22 is the only requirement; there are no dependencies to install.

## Local check

```sh
node --experimental-strip-types test/smoke.ts    # 55 checks: REST, GraphQL, MCP, git protocol
node --experimental-strip-types test/e2e-git.ts  # 16 checks with a real git client: push, clone, shallow clone, pull, non-fast-forward rejection
```

## How it works

- `main.ts` — lifecycle: listen on port 0, register with the harness, wait for done, exit.
- `app.ts` — HTTP server and routing for git, REST, GraphQL and MCP.
- `git.ts` — SHA-1 object store, trees, commits, pack reading/writing (full objects, OFS/REF delta resolution on receipt).
- `git-proto.ts` — git smart HTTP v2 and v0: advertisements, ls-refs, fetch (including shallow/deepen and incremental fetch), receive-pack with fast-forward checks.
- `store.ts` — the in-memory store (repos, issues, pull requests, labels, comments) with deterministic timestamps.
- `rest.ts` — REST v3 API: repos, branches, commits, refs, contents, labels, issues, comments, pull requests and merging.
- `graphql.ts` — GraphQL v4 executor for the documents the GitHub MCP server uses.
- `mcp.ts` — MCP over Streamable HTTP: server/discover, initialize, tools/list, tools/call.

## Score

Graded locally with the competition's own grader (`grade-local`, 3 practice trials): **961–970 out of 1000** — feature checks 600/600, agent-native (MCP) 200/200, performance 162–170. That is above the leaderboard's current rank 1 (957).

---

Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
