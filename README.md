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

The Worker needs:

- A D1 database named `roger`; put its `database_id` in `apps/worker/wrangler.jsonc`.
- A route for `APP_ORIGIN`. `workers_dev` is off, so add a custom domain in
  `wrangler.jsonc`, for example `"routes": [{ "pattern": "roger.origin89.com", "custom_domain": true }]`.
- A GitHub OAuth App (not a GitHub App) with the callback URL
  `<APP_ORIGIN>/auth/callback`. Sign-in asks for `read:org`, uses the token
  once to check team membership, and discards it. If the organization
  restricts third-party OAuth apps, an owner must approve this one, or every
  sign-in is refused as not a member.
- These settings:

| Name | Kind | Meaning |
| --- | --- | --- |
| `APP_ORIGIN` | var | Where the inbox is served; also the passkey relying party |
| `GITHUB_CLIENT_ID` | var | OAuth app client id |
| `GITHUB_CLIENT_SECRET` | secret | OAuth app secret |
| `GITHUB_ORG`, `GITHUB_TEAM` | var | Only active members of this team can sign in |
| `NTFY_URL` | var | ntfy server; empty disables pushes. Each person picks a topic in Settings |
| `NTFY_TOKEN` | secret | Optional ntfy access token |
| `TIME_ZONE`, `WORK_HOURS`, `WORK_DAYS` | var | Working hours for quiet hours, `soon` pushes, expiry, and the digest |

Apply migrations with
`pnpm --filter roger-worker exec wrangler d1 migrations apply roger --remote`
before deploying. A passkey can only be removed from D1 directly:
`DELETE FROM passkeys WHERE id = '<credential id>'`.

## License

Licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at
your option (`MIT OR Apache-2.0`).
