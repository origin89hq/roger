# Roger

One inbox for agents that need a person.

An agent asks through the `roger` CLI (a single Rust binary) or the API and, if it chooses, blocks until
someone answers. Asks from Orca, opencode, GitHub Actions, or a cron script share
one priority inbox. Roger records the decision and returns it to the requester,
which acts on it. Roger itself never merges, deploys, or runs an agent.

```sh
roger ask --kind approval --priority p1 \
  --title "Merge origin89hq/engineering#25?" \
  --subject pr:origin89hq/engineering#25 --rev 99052e8 \
  --option approve --option reject --wait
```

Status: design only. The design is in the [Roger RFC](https://github.com/origin89hq/roger/issues/1).

## Development

Requires Node 24+, pnpm (pinned in `package.json`), and `just`.

```sh
pnpm install
just check
```

## License

Licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at
your option (`MIT OR Apache-2.0`).
