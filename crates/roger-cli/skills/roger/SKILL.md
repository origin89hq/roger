---
name: roger
description: Ask a person for a decision through Roger and act on the answer. Use when an agent, coordinator, or scheduled job needs human approval or a human choice it may not make itself, such as merging, releasing, or resolving an open product question, and `roger` is installed with a token.
license: MIT OR Apache-2.0
---

# Ask a person through Roger

Roger holds one Ask per decision in a person's inbox and returns their answer.
It records decisions and never acts on them: you ask, a person answers in the
browser, and you act on the answer yourself, then report what you did.

Ask only for decisions you may not make: an action outside your authority, an
irreversible step, or a genuine product choice. Resolve everything else from
the code, the issue, or existing rules first. An Ask interrupts a person.

## Check the setup

```sh
roger --version && roger list --open >/dev/null
```

Exit 0 means the binary and token work. Otherwise, stop and report; do not
fall back to guessing the answer.

- Install or update with `cargo install --locked roger-cli`.
- The token comes from `ROGER_TOKEN`, the file named by `ROGER_TOKEN_FILE`, or
  `~/.config/roger/token`. A person creates it in the inbox under Settings,
  one requester per automation and machine, such as `orca@studio`.
- `ROGER_URL` defaults to `https://roger.origin89.com`.

## Ask

```sh
roger ask --kind approval --urgency later --risk routine \
  --title "Merge: fix: keep stale readings out of totals" \
  --decision-key merge:origin89hq/cloud#41 \
  --action-verb merge --action-target pr:origin89hq/cloud#41 \
  --action-rev "$HEAD_SHA" --action-limits "squash merge into main" \
  --link "PR=https://github.com/origin89hq/cloud/pull/41" \
  --option approve:approve:Merge --option reject:reject:Leave \
  --option fix:other:"Fix first" --input-required fix \
  --idem "merge-gate:cloud#41@$HEAD_SHA" --body-file /tmp/ask.md
```

- **Kind.** `approval` asks permission for one exact action and needs
  `--action-*`, one `approve` and one `reject` option. `question` asks for a
  choice or instructions and offers only `other` options. `fyi` needs no
  answer.
- **Action.** `--action-rev` is the full 40-character SHA the approval covers.
  An approval permits that action at that revision and nothing else.
- **Urgency** decides delivery: `now` pushes immediately, even at night, so
  use it only when something is waiting minutes on the answer. `soon` pushes
  after 30 working minutes, `later` waits for the morning digest, and `fyi`
  stays in the inbox.
- **Risk** decides presentation: `routine`, `sensitive` (secrets, spending,
  authorization, data loss), or `irreversible` (production data, releases,
  equipment). Never lower a risk to make an Ask look routine.
- **Decision key** names the decision, such as `merge:<repo>#<pr>` or
  `naming:<topic>`. Only one Ask per key can be open for your requester.
- **Idempotency key** makes a retried `ask` return the same Ask. Include the
  revision or input that makes the question distinct.
- **Supersede** your own open Ask when its premise changes, for example a new
  head SHA: `--supersedes <old id>` with the same decision key. Asking again
  without it fails with a conflict that names the open Ask.
- `--to <login>` addresses someone other than the requester's owner.
  `--repo` defaults to this checkout's `origin`.
- Put the context in `--body-file`: what you checked, the options, and your
  recommendation. Link logs and diffs; do not paste them. The title is one line.
- One Ask per blocked item, listing every open decision for it. A follow-up
  question is a new Ask.

For a reversible question, say which option you will proceed with unless told
otherwise, and keep working. Never do that for an approval.

## Receive the answer

`roger get <id>` and `roger wait <id>` print the Ask as JSON and exit with:

| Exit | Meaning | Do |
| --- | --- | --- |
| 0 | Approved | Re-check your own rules at the approved revision, then act |
| 10 | Rejected | Do not act |
| 11 | Answered with an `other` option | Read `.answer.optionId` and `.answer.input` and follow them |
| 20 | Expired | Nobody decided. Do not act; ask again later if it still matters |
| 21 | Withdrawn or superseded | Stop tracking this Ask |
| 22 | Still open | Wait again, or come back on your next run |
| 1 | Error | Report it; never treat it as an answer |

Branch on the exit code or on `.answer.decision`, never on option order or
labels. An answer applies only to the Ask's action and revision; if the head
moved, it does not apply.

Choose how to wait:

- **In a live session**, for a `now` Ask: `roger wait <id> --timeout 9m`, and
  run it again on exit 22. Shell tools cap a command's run time, so never
  block for longer.
- **Across runs**, for everything else: record the Ask id with the parked
  work, end the run, and on each later run read
  `roger list --answered --unfinished`. It returns every answered Ask of your
  requester that you have not finished.

## Report what happened

Roger records `delivered` when you first read the answer. Then report:

```sh
roger trace <id> dispatched --ref orca.run=<run> --ref orca.task=<task> --ref branch=<branch>
roger trace <id> progress --note "pushed 1a2b3c4"
roger trace <id> applied --url <merge commit or PR>
roger trace <id> failed --url <log> --note "<reason>"
roger trace <id> not_applicable --note "head moved to <sha>"
```

End every answered Ask with exactly one of `applied`, `failed`, or
`not_applicable`; until you do, `list --answered --unfinished` returns it and
the inbox shows it as stalled. Acting must be safe to repeat: you may crash
after acting and before tracing, so check first (is the PR already merged?).

## Integrations

Tools with their own conventions have their own skill, printed by
`roger skill <name>`. Read the one for your tool before asking:

- `orca`: coordinators, parked Tasks, and the Orca merge gate.

Roger never grants authority you do not already have: an approval lets you
take the approved action only where your instructions already allow acting on
a person's approval.
