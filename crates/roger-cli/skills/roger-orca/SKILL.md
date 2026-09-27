---
name: roger-orca
description: Route Orca decisions that need a person through Roger. Use in an Orca coordinator that parks a Task on a human decision, and in the Orca merge gate when it hands a PR to a person, whenever `roger` is installed with a token. Read the core `roger` skill first.
license: MIT OR Apache-2.0
---

# Roger in Orca

Read the core skill first (`roger skill`). This skill changes only where Orca
used to leave a decision in a report or a PR label: the decision also becomes
a Roger Ask, and the run picks the answer up on a later pass. Orca's own rules
still decide what may be done; Roger only records who decided.

Use one requester per Orca host and job, such as `orca@studio` for
coordinators and `orca-merge-gate@studio` for the gate, so their unfinished
answers stay separate.

## Coordinator escalations

When a worker escalates a decision outside its authority:

1. Park the Task as before, with `gate-create` when dependents must wait.
2. Ask, with the worker's question and your recommendation in the body:

   ```sh
   roger ask --kind question --urgency later --risk <risk> \
     --title "<Task>: <the decision in one line>" \
     --decision-key "task:<run>/<task>" \
     --resume-run <run> --resume-task <task> --resume-branch <branch> --resume-rev <sha> \
     --option <id>:other:<label> ... --idem "task:<run>/<task>@<sha>" --body-file <file>
   ```

   Use `--kind approval` with `--action-*` when the decision is permission
   for one action. Use `--urgency soon` only when a worker is blocked with
   nothing else to do.
3. Put the Ask id and its inbox link in the run report, and keep the other
   Tasks moving. Do not wait in the coordinator's session.
4. On each later pass, run `roger list --answered --unfinished`. For each Ask
   whose decision key is one of your Tasks, start a fresh worker from the Task
   spec plus the answer (`.answer.optionId`, `.answer.input`), and trace
   `dispatched` with `--ref orca.run=<run> --ref orca.task=<task>`.
5. Trace `applied`, `failed`, or `not_applicable` when the Task settles. An
   expired, withdrawn, or rejected Ask resumes nothing.

## Merge gate

The gate keeps every rule in its reference. Roger changes the hand-over and
adds a return path.

**Hand over.** When the gate hands a PR over, it still adds
`needs-human-review` and posts its comment, and it also asks:

```sh
roger ask --kind approval --urgency later --risk <from the repository's risk classes> \
  --title "Merge: <PR title>" --decision-key "merge:<owner>/<repo>#<number>" \
  --repo <owner>/<repo> \
  --action-verb merge --action-target "pr:<owner>/<repo>#<number>" \
  --action-rev <full head sha> --action-limits "squash merge into <base>" \
  --link "PR=<url>" \
  --option approve:approve:Merge --option reject:reject:Leave \
  --option fix:other:"Fix first" --input-required fix \
  --idem "merge-gate:<owner>/<repo>#<number>@<head sha>" --body-file <failed rules and findings>
```

Put the Ask id in the hand-over comment. Use `sensitive` or `irreversible`
when the diff touches a risk class, never `routine`.

**Return path.** The precheck also continues when
`roger list --answered --unfinished` returns any Ask, so answers are picked
up even when every open PR is labelled. For each answered merge Ask:

- **approve**: the approval replaces only "a person with write access
  approved this head" in the risk-class rule. Re-check every other merge rule
  at the approved SHA. If the head moved, trace `not_applicable` and ask again
  with `--supersedes`. If a rule fails, hand over again. Otherwise merge with
  `--match-head-commit <approved sha>`, remove `needs-human-review`, and trace
  `applied` with the merge commit. A PR that is already merged traces
  `applied` with the existing merge.
- **fix**: under the fix-request grant only, send `.answer.input` to the
  branch's worker through the existing fix-request path, and trace
  `dispatched` with the worktree and the fix-request comment. The next run
  that judges the new head traces `progress`; the final merge or hand-over
  traces the terminal event. Without that grant, trace `not_applicable` and
  leave the PR to the person.
- **reject**: leave the PR labelled and trace `applied`.

When the head moves while a merge Ask is open, supersede it on the next run.
Never merge from an expired, withdrawn, or superseded Ask, and never from an
answer to a different revision.
