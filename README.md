# Roger

One inbox for agents that need a person.

An agent asks through the `roger` CLI and reads the answer when it next runs,
or waits for it. Each Ask goes to one person, who answers in a web inbox signed
in with GitHub; approvals need a passkey. Roger records the decision and returns
it to the requester, which acts on it. Roger itself never merges, deploys, or
runs an agent.

```sh
roger ask --kind approval --urgency later --risk routine \
  --to lemarier \
  --title "Merge: feat: follow a PR until it merges" \
  --decision-key merge:origin89hq/engineering#25 \
  --action-verb merge --action-target pr:origin89hq/engineering#25 \
  --action-rev 99052e8d50ab39ba6e38d1fc68e3442afcfd5892 \
  --option approve:approve:Merge --option reject:reject:Leave \
  --option fix:other:"Fix (describe)" --input-required fix \
  --idem merge-gate:engineering#25@99052e8
```

`--repo` defaults to the checkout's `origin` remote, and `--to` defaults to the
person who created the requester. `roger get <id>` and `roger wait <id>` print
the Ask as JSON and exit `0` for approve, `10` reject, `11` other, `20`
expired, `21` withdrawn or superseded, `22` still open. A scheduled job reads
its unfinished answers with `roger list --answered --unfinished` and reports
what it did with `roger trace <id> dispatched|progress|applied|failed|not_applicable`.
`roger --help` lists every flag.

Install the CLI with `cargo install --locked roger-cli`; rerunning it updates
to the latest release. Then log the machine in once:

```sh
roger login                      # prints a code; enter it on github.com
roger ask --as merge-gate ...    # or export ROGER_REQUESTER=merge-gate
```

`roger login` signs in with GitHub's device flow, using the same OAuth app as
the inbox (device flow must be enabled on it). The person enters the code on
github.com. The CLI asks only for `read:org`, which the team membership check
needs, and sends the GitHub token once to the Worker. The Worker accepts only
a token issued to its own OAuth app (a personal access token is refused), runs
the same checks as inbox sign-in (who the person is and membership of
`GITHUB_TEAM`), revokes the GitHub token on every path, and returns a machine
credential. Membership is checked at login only: removing someone from the
team does not revoke their machines, so revoke those in Settings. The client
secret stays a Worker secret; the CLI never sees it. The
machine is named with `--machine`, defaulting to the host name, such as
`studio`; a name belongs to one person while it is logged in. The CLI saves the
machine credential to `~/.config/roger/credentials` with mode 0600; the Worker
stores only its hash, and no GitHub token is kept anywhere. Each automation names itself with `--as <name>` or
`ROGER_REQUESTER`, and Roger resolves it to the requester `<machine>/<name>`,
created on first use. A call without a name acts as `<machine>/default`.
Asks, idempotency keys, decision keys, and `list` stay per requester, so jobs
on one machine do not see each other's answers. Settings lists each machine
and its requesters: disabling a requester stops one automation, and revoking
the machine, or `roger logout` on it, stops all of them.

Any process that can read a machine's credential can act as any of that
machine's requesters, as every job on a machine could read a shared token file
before. Requester names separate bookkeeping, not privilege.

Requesters and tokens created under Settings keep working, and any token takes
precedence over the login: `ROGER_TOKEN`, then `ROGER_TOKEN_FILE`, then
`~/.config/roger/token`. To move such a requester to the login, adopt it to
the machine in Settings, so `--as <name>` there keeps its Asks, and remove the
token from the job. `ROGER_URL` defaults to `https://roger.origin89.com`.

The Worker admits 10 logins per minute per client IP, through the `LOGINS`
rate-limit binding in `wrangler.jsonc`; without the binding it
refuses every login. Machines behind one NAT share that limit, so log them in
one at a time.

## Agent skills

The CLI ships the skills that tell an agent when and how to ask, matched to its
version:

| Skill | Print with | For |
| --- | --- | --- |
| [roger](skills/roger/SKILL.md) | `roger skill` | Any agent or script: asking, waiting, exit codes, tracing |
| [roger-orca](skills/roger-orca/SKILL.md) | `roger skill orca` | Orca coordinators and the merge gate |

The canonical files live in `crates/roger-cli/skills/`; `skills/` holds copies
for skill installers, and a test fails when they differ. Add an integration as
`roger-<tool>` in both places and register it in `SKILLS` in
`crates/roger-cli/src/commands.rs`.

The design is the [Roger RFC](https://github.com/origin89hq/roger/issues/1).

## Layout

| Path | Contents |
| --- | --- |
| `apps/worker` | Cloudflare Worker: the agent API, the inbox, GitHub sign-in, passkeys, ntfy pushes, and the cron that expires Asks, retries pushes, sends the morning digest, and purges old bodies |
| `crates/roger-protocol` | Wire types; generates `apps/worker/src/protocol.gen.ts` |
| `crates/roger-cli` | The `roger` binary |

## Development

Requires Node 24+, pnpm (pinned in `package.json`), Rust (pinned in
`rust-toolchain.toml`), and `just`.

```sh
pnpm install
just check      # Rust checks, then Biome, typecheck, tests, and build
just protocol   # regenerate the TypeScript after changing roger-protocol
```

`just dev` applies migrations to a local D1 and serves the Worker on
`http://localhost:8792`. Copy `apps/worker/.dev.vars.example` to
`apps/worker/.dev.vars` and fill in a GitHub OAuth app whose callback is
`http://localhost:8792/auth/callback`.

## Releasing the CLI

Bump `version` in `crates/roger-protocol/Cargo.toml` and
`crates/roger-cli/Cargo.toml` (and the `roger-protocol` version in the root
`Cargo.toml`), merge, then push the tag `v<version>` on that commit. The
`release-crates` workflow checks that the tag matches, runs the Rust checks,
and publishes both crates through crates.io trusted publishing from the
`crates-io` environment, which accepts only `v*` tags.

## Deployment

Roger runs at <https://roger.origin89.com> as the `roger` Worker with the D1
database `roger`; both are set in `apps/worker/wrangler.jsonc`, with the custom
domain route and the public settings.

The `deploy` job in `origin89-check.yml` deploys each `main` commit after the
checks pass, or on a manual run on `main`. It applies D1 migrations, then runs
`wrangler deploy` with the Worker's secret. It uses:

| Name | Where | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | organization secret, granted to this repository | Deploys the Worker and applies migrations |
| `CLOUDFLARE_ACCOUNT_ID` | repository variable | Cloudflare account |
| `ROGER_GITHUB_CLIENT_SECRET` | `roger-production` environment secret | The OAuth App secret, deployed as the Worker secret `GITHUB_CLIENT_SECRET`; GitHub reserves the `GITHUB_` prefix |

The `roger-production` environment only accepts `main`. To rotate the OAuth
secret, update the environment secret and rerun the workflow on `main`.

Sign-in uses a GitHub OAuth App (not a GitHub App) with the callback URL
`https://roger.origin89.com/auth/callback`. It asks for `read:org`, uses the
token once to check membership of `GITHUB_TEAM`, and discards it. If the
organization restricts third-party OAuth apps, an owner must approve this one,
or every sign-in is refused as not a member.

| Worker setting | Meaning |
| --- | --- |
| `APP_ORIGIN` | Where the inbox is served; also the passkey relying party |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The OAuth App |
| `GITHUB_ORG`, `GITHUB_TEAM` | Only active members of this team can sign in |
| `NTFY_URL`, `NTFY_TOKEN` | ntfy server and optional token; an empty URL disables pushes. Each person picks a topic in Settings |
| `TIME_ZONE`, `WORK_HOURS`, `WORK_DAYS` | Working hours for quiet hours, `soon` pushes, expiry, and the digest |

A passkey can only be removed from D1 directly:
`pnpm --filter roger-worker exec wrangler d1 execute roger --remote --command "DELETE FROM passkeys WHERE id = '<credential id>'"`.

## License

Licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at
your option (`MIT OR Apache-2.0`).
