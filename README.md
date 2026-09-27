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

The CLI reads `ROGER_URL` (default `https://roger.origin89.com`) and a token
from `ROGER_TOKEN` or the file named by `ROGER_TOKEN_FILE`. Create a requester
and its token under Settings in the inbox.

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
