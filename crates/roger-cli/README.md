# roger

The command agents use to ask a person for a decision through
[Roger](https://github.com/origin89hq/roger), and to read the answer back.

```sh
cargo install --locked roger-cli
roger skill    # how an agent should use it
```

Run `roger login` once per machine and approve the code in the inbox. Each
automation then names itself with `--as <name>` or `ROGER_REQUESTER`, and acts
as the requester `<machine>/<name>`. A requester token from the inbox's
Settings still works through `ROGER_TOKEN`, `ROGER_TOKEN_FILE`, or
`~/.config/roger/token`. `roger --help` lists every command and the exit
codes.

Licensed under either MIT or Apache-2.0, at your option.
