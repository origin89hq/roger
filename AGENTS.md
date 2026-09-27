# Working in this repository

For hosted PR reviews, follow `Code Review Rules` below without running the local
skills refresh. For other tasks, run `just skills-sync` from the repository root.
Read `skills/origin89-working/SKILL.md` and the relevant domain skills under the
immutable `path` printed by that command. Keep that snapshot for the task; do not
refresh it halfway through work. Before branch, commit, push, or PR operations,
read `skills/origin89-commits/SKILL.md` from that snapshot. Read local instructions
and preserve stronger project constraints and project-specific skills.

If refresh reports cached content, continue with that verified cache and mention
that the script could not check for updates. If no cache is available or
validation fails, report the error; do not claim the shared rules loaded. Local
instructions and the user's request still apply. Do not overwrite local skill
files to fix a conflict without reconciling them.

[Origin89 engineering](https://github.com/origin89hq/engineering) owns the shared
rules. Keep only repository-specific architecture, commands, target constraints,
and exceptions below. Internal RFCs and research belong in
[internal-research](https://github.com/origin89hq/internal-research). Add documentation
only when its value and upkeep are clear; remove AI filler from every message.

Confirmed problems left outside the current fix need an issue in the owning
repository: search with `gh`, reuse a matching issue or create one with evidence,
and return its URL. Follow the shared working skill's unfinished-work rule.
Respect posting restrictions; if filing is blocked, provide the draft and say why.
Finish authorized fixes instead of replacing them with backlog issues.

## Roger

Roger holds requests from agents ("Asks") in one priority inbox and hands each
answer back to the requester. The design is the
[Roger RFC](https://github.com/origin89hq/roger/issues/1);
update it when a decision there changes.

Planned layout, created as code lands:

```text
apps/worker/            Cloudflare Worker (Hono, Zod): API, D1, Durable Object per open Ask, web inbox
crates/roger-protocol/  Ask, Answer, and error types; TypeScript is generated from here
crates/roger-cli/       `roger` binary: login, ask, wait, answer, inbox, tokens
```

Run `just check` before pushing. It runs Biome, then typecheck, test, and build
in every workspace package. Add the Rust checks from engineering's
`templates/just/rust.justfile` along with the first crate.

Roger records decisions and never acts on them. Do not give the Worker GitHub
write access, Orca access, deploy credentials, or any other effect; requesters
act on answers themselves.

## Code Review Rules

Read the shared `origin89-review` skill and relevant domain skills when available.
In hosted review jobs that already provide `.origin89/engineering/skills/`, use
that checkout without running the local refresh. If shared context is missing,
review against the rules below and disclose that limit.

- Flag changes that bypass authorization, lose data or provenance, break a
  supported contract, or turn unknown or stale equipment input into permission
  to act. Check callers and existing guards before reporting a defect.
- Require meaningful success, invalid-input, boundary, and failure coverage for
  changed nontrivial behavior. Respect simpler contracts with fewer paths;
  hazardous behavior needs its full fault matrix and relevant bench evidence.
- For Rust domain logic, prefer typed state, errors, units, and identifiers.
  Strings at text boundaries are expected; flag strings that discard useful
  invariants or leave invalid domain states representable.
- Report the trigger, consequence, and precise location. Distinguish checks run
  from missing evidence. Leave formatting to the configured linters, and avoid
  duplicate or speculative findings. A review request does not authorize implementation.
- Agent tokens create, read, withdraw, and trace their own requester's Asks
  only. Flag any path that lets a bearer token, a human CLI credential, or a
  session without a passkey assertion record an `approve` decision.
- Approvals are bound to the Ask's action and full revision. Flag answer paths
  that skip the revision check, logic that infers a decision from option
  order, and expiry that produces any answer.
- State transitions happen once, from `open`, in one D1 batch with their audit
  record. Flag read-then-write races and trace writes after a terminal event.
- Flag unbounded request bodies, traces, or result sets, and push payloads that
  include an Ask's body, links, or action.
- Keep current PR defects in the review. Track confirmed pre-existing or explicitly
  deferred problems as issues when filing is authorized; comments-only reviewers
  provide a draft and state that it was not filed.
