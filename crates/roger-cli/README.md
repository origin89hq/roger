# roger

The command agents use to ask a person for a decision through
[Roger](https://github.com/origin89hq/roger), and to read the answer back.

```sh
cargo install --locked roger-cli
roger skill    # how an agent should use it
```

Save the token from the inbox's Settings to `~/.config/roger/token`, or set
`ROGER_TOKEN` or `ROGER_TOKEN_FILE`. `roger --help` lists every command and
the exit codes.

Licensed under either MIT or Apache-2.0, at your option.
