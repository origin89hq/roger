import { addWorkingMinutes, type Schedule } from "./config.ts";
import { canonicalJson, sha256, ulid } from "./ids.ts";
import type {
  Action,
  AppendTrace,
  Ask,
  AskOption,
  AskState,
  CreateAsk,
  Decision,
  Link,
  Resume,
  StateChange,
  TraceEntry,
  TraceEvent,
} from "./protocol.gen.ts";
import { LIMITS } from "./schemas.ts";

/** A requester, as resolved from an agent token. */
export interface Requester {
  id: string;
  name: string;
  createdBy: number;
}

/** A person signed in to the inbox. */
export interface Responder {
  githubId: number;
  login: string;
}

/** Who caused a transition, as recorded in `ask_events.actor`. */
export type Actor =
  | { kind: "requester"; id: string }
  | { kind: "responder"; githubId: number }
  | { kind: "roger" };

function actorName(actor: Actor): string {
  switch (actor.kind) {
    case "requester":
      return `requester:${actor.id}`;
    case "responder":
      return `github:${actor.githubId}`;
    case "roger":
      return "roger";
    default: {
      const unreachable: never = actor;
      throw new Error(`unknown actor ${String(unreachable)}`);
    }
  }
}

/** An Ask plus the ids the Worker needs to authorize access to it. */
export interface StoredAsk {
  ask: Ask;
  requesterId: string;
  responderId: number;
}

export type CreateResult =
  | { kind: "created"; ask: Ask }
  | { kind: "existing"; ask: Ask }
  | { kind: "invalid"; message: string }
  | { kind: "conflict"; message: string; state: AskState | null };

export type TransitionResult =
  | { kind: "done"; ask: Ask }
  | { kind: "conflict"; state: AskState | null; message: string };

export interface AnswerRecord {
  option: AskOption;
  input: string | null;
  responder: Responder;
  passkeyId: string | null;
}

export type StallReason = "not_delivered" | "not_finished";

export interface Stalled {
  ask: Ask;
  reason: StallReason;
}

export interface PushJob {
  askId: string;
  title: string;
  urgency: Ask["urgency"];
  risk: Ask["risk"];
  requester: string;
  repo: string | null;
  topic: string;
}

interface AskRow {
  id: string;
  requester_id: string;
  requester_name: string;
  responder_id: number;
  to_login: string;
  decision_key: string;
  repo: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  kind: Ask["kind"];
  urgency: Ask["urgency"];
  risk: Ask["risk"];
  title: string;
  body: string | null;
  links: string | null;
  action: string | null;
  options: string;
  resume: string | null;
  expires_at: number | null;
  state: AskState;
  created_at: number;
  closed_at: number | null;
}

interface AnswerRow {
  ask_id: string;
  option_id: string;
  option_label: string;
  decision: Decision;
  input: string | null;
  action: string | null;
  responder_id: number;
  responder: string;
  passkey_id: string | null;
  answered_at: number;
}

interface TraceRow {
  id: string;
  ask_id: string;
  event: TraceEvent;
  refs: string;
  url: string | null;
  note: string | null;
  at: number;
}

const ASK_COLUMNS = `a.id, a.requester_id, r.name AS requester_name, a.responder_id,
  p.login AS to_login, a.decision_key, a.repo, a.supersedes,
  (SELECT s.id FROM asks s WHERE s.supersedes = a.id) AS superseded_by,
  a.kind, a.urgency, a.risk, a.title, a.body, a.links, a.action, a.options, a.resume,
  a.expires_at, a.state, a.created_at, a.closed_at`;
const ASK_FROM = `asks a JOIN requesters r ON r.id = a.requester_id
  JOIN responders p ON p.github_id = a.responder_id`;
const TERMINAL = `('applied', 'failed', 'not_applicable')`;
const URGENCY_ORDER = `CASE a.urgency WHEN 'now' THEN 0 WHEN 'soon' THEN 1 WHEN 'later' THEN 2 ELSE 3 END`;
const SOON_PUSH_MINUTES = 30;
const RETENTION_MS = 90 * 24 * 60 * 60_000;

/** Parses JSON this Worker wrote after validating it. */
function stored<T>(text: string): T {
  return JSON.parse(text) as T;
}

function isUniqueViolation(error: unknown, columns: string): boolean {
  return (
    error instanceof Error &&
    error.message.includes(`UNIQUE constraint failed: ${columns}`)
  );
}

export class Store {
  constructor(private readonly db: D1Database) {}

  // ---- Asks: reading ------------------------------------------------------

  async getAsk(id: string): Promise<StoredAsk | null> {
    const row = await this.db
      .prepare(`SELECT ${ASK_COLUMNS} FROM ${ASK_FROM} WHERE a.id = ?`)
      .bind(id)
      .first<AskRow>();
    if (!row) return null;
    const [stored] = await this.hydrate([row]);
    return stored ?? null;
  }

  private async hydrate(rows: AskRow[]): Promise<StoredAsk[]> {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map((r) => r.id));
    const [answers, traces] = await this.db.batch([
      this.db
        .prepare(
          "SELECT * FROM answers WHERE ask_id IN (SELECT value FROM json_each(?))",
        )
        .bind(ids),
      this.db
        .prepare(
          "SELECT * FROM trace WHERE ask_id IN (SELECT value FROM json_each(?)) ORDER BY id",
        )
        .bind(ids),
    ]);
    const answerBy = new Map<string, AnswerRow>();
    for (const a of (answers?.results ?? []) as AnswerRow[])
      answerBy.set(a.ask_id, a);
    const traceBy = new Map<string, TraceEntry[]>();
    for (const t of (traces?.results ?? []) as TraceRow[]) {
      const list = traceBy.get(t.ask_id) ?? [];
      list.push({
        id: t.id,
        event: t.event,
        refs: stored<Record<string, string>>(t.refs),
        url: t.url,
        note: t.note,
        at: t.at,
      });
      traceBy.set(t.ask_id, list);
    }
    return rows.map((row) => {
      const answer = answerBy.get(row.id);
      return {
        requesterId: row.requester_id,
        responderId: row.responder_id,
        ask: {
          id: row.id,
          requester: row.requester_name,
          to: row.to_login,
          repo: row.repo,
          decisionKey: row.decision_key,
          supersedes: row.supersedes,
          supersededBy: row.superseded_by,
          kind: row.kind,
          urgency: row.urgency,
          risk: row.risk,
          title: row.title,
          body: row.body,
          links: row.links === null ? [] : stored<Link[]>(row.links),
          action: row.action === null ? null : stored<Action>(row.action),
          options: stored<AskOption[]>(row.options),
          resume: row.resume === null ? null : stored<Resume>(row.resume),
          expiresAt: row.expires_at,
          state: row.state,
          createdAt: row.created_at,
          closedAt: row.closed_at,
          answer: answer
            ? {
                optionId: answer.option_id,
                optionLabel: answer.option_label,
                decision: answer.decision,
                input: answer.input,
                action:
                  answer.action === null ? null : stored<Action>(answer.action),
                responder: answer.responder,
                responderId: answer.responder_id,
                passkey: answer.passkey_id !== null,
                answeredAt: answer.answered_at,
              }
            : null,
          trace: traceBy.get(row.id) ?? [],
        },
      };
    });
  }

  /**
   * The requester's Asks in `state`, oldest first. `unfinished` keeps only
   * answered Asks without a terminal trace event.
   */
  async listForRequester(
    requesterId: string,
    state: AskState,
    unfinished: boolean,
    after: string | null,
    limit: number,
  ): Promise<{ asks: Ask[]; next: string | null }> {
    const rows = await this.db
      .prepare(
        `SELECT ${ASK_COLUMNS} FROM ${ASK_FROM}
         WHERE a.requester_id = ?1 AND a.state = ?2 AND a.id > ?3
           AND (?4 = 0 OR NOT EXISTS (
             SELECT 1 FROM trace t WHERE t.ask_id = a.id AND t.event IN ${TERMINAL}))
         ORDER BY a.id LIMIT ?5`,
      )
      .bind(requesterId, state, after ?? "", unfinished ? 1 : 0, limit + 1)
      .all<AskRow>();
    const page = rows.results.slice(0, limit);
    const asks = (await this.hydrate(page)).map((s) => s.ask);
    return {
      asks,
      next: rows.results.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /**
   * Records `delivered` for each answered Ask that lacks it. The partial unique
   * index makes repeated and concurrent reads record it once.
   */
  async markDelivered(asks: readonly Ask[], now: number): Promise<void> {
    const pending = asks.filter(
      (a) => a.answer !== null && !a.trace.some((t) => t.event === "delivered"),
    );
    if (pending.length === 0) return;
    await this.db.batch(
      pending.map((a) =>
        this.db
          .prepare(
            `INSERT OR IGNORE INTO trace (id, ask_id, event, at)
             SELECT ?1, ask_id, 'delivered', ?2 FROM answers WHERE ask_id = ?3`,
          )
          .bind(ulid(now), now, a.id),
      ),
    );
  }

  async events(
    requesterId: string,
    after: number,
    limit: number,
  ): Promise<{ events: StateChange[]; askIds: string[] }> {
    const rows = await this.db
      .prepare(
        `SELECT e.seq, e.ask_id, a.decision_key, e.state, e.at
         FROM ask_events e JOIN asks a ON a.id = e.ask_id
         WHERE e.requester_id = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`,
      )
      .bind(requesterId, after, limit)
      .all<{
        seq: number;
        ask_id: string;
        decision_key: string;
        state: AskState;
        at: number;
      }>();
    return {
      events: rows.results.map((r) => ({
        cursor: r.seq,
        askId: r.ask_id,
        decisionKey: r.decision_key,
        state: r.state,
        at: r.at,
      })),
      askIds: rows.results
        .filter((r) => r.state === "answered")
        .map((r) => r.ask_id),
    };
  }

  // ---- Asks: creating -----------------------------------------------------

  async createAsk(
    requester: Requester,
    input: CreateAsk,
    now: number,
    schedule: Schedule,
  ): Promise<CreateResult> {
    const { idemKey, ...content } = input;
    const contentHash = await sha256(canonicalJson(content));
    const existing = await this.byIdemKey(requester.id, idemKey, contentHash);
    if (existing) return existing;

    let responderId = requester.createdBy;
    if (input.to) {
      const found = await this.db
        .prepare(
          "SELECT github_id FROM responders WHERE lower(login) = lower(?)",
        )
        .bind(input.to)
        .first<{ github_id: number }>();
      if (!found)
        return {
          kind: "invalid",
          message: `${input.to} has not signed in to Roger, so they cannot receive Asks yet.`,
        };
      responderId = found.github_id;
    }

    const id = ulid(now);
    const actor = actorName({ kind: "requester", id: requester.id });
    const pushDueAt =
      input.urgency === "now"
        ? now
        : input.urgency === "soon"
          ? addWorkingMinutes(now, SOON_PUSH_MINUTES, schedule)
          : null;
    const expiresAt = input.expiresInMinutes
      ? addWorkingMinutes(now, input.expiresInMinutes, schedule)
      : null;
    const values = [
      id,
      requester.id,
      idemKey,
      contentHash,
      input.decisionKey,
      responderId,
      input.repo ?? null,
      input.supersedes ?? null,
      input.kind,
      input.urgency,
      input.risk,
      input.title,
      input.body ?? null,
      JSON.stringify(input.links ?? []),
      input.action
        ? JSON.stringify({
            ...input.action,
            limits: input.action.limits ?? null,
          })
        : null,
      JSON.stringify(
        input.options.map((o) => ({
          ...o,
          inputRequired: o.inputRequired ?? false,
        })),
      ),
      input.resume ? JSON.stringify(input.resume) : null,
      expiresAt,
      pushDueAt,
      now,
    ];
    const insert = this.db
      .prepare(
        `INSERT INTO asks (id, requester_id, idem_key, content_hash, decision_key, responder_id,
           repo, supersedes, kind, urgency, risk, title, body, links, action, options, resume,
           expires_at, push_due_at, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
           ?18, ?19, ?20
         WHERE ?21 = 0 OR changes() = 1`,
      )
      .bind(...values, input.supersedes ? 1 : 0);
    const opened = this.db
      .prepare(
        `INSERT INTO ask_events (ask_id, requester_id, state, actor, at)
         SELECT ?1, ?2, 'open', ?3, ?4 WHERE changes() = 1`,
      )
      .bind(id, requester.id, actor, now);

    const statements: D1PreparedStatement[] = [];
    if (input.supersedes) {
      // Close the named Ask only if it is this requester's open Ask for the same
      // decision; the insert below runs only if that succeeded.
      statements.push(
        this.db
          .prepare(
            `UPDATE asks SET state = 'superseded', closed_at = ?1
             WHERE id = ?2 AND requester_id = ?3 AND decision_key = ?4 AND state = 'open'`,
          )
          .bind(now, input.supersedes, requester.id, input.decisionKey),
        this.db
          .prepare(
            `INSERT INTO ask_events (ask_id, requester_id, state, actor, at)
             SELECT ?1, ?2, 'superseded', ?3, ?4 WHERE changes() = 1`,
          )
          .bind(input.supersedes, requester.id, actor, now),
      );
    }
    statements.push(insert, opened);

    try {
      const results = await this.db.batch(statements);
      const inserted = results.at(-2)?.meta.changes === 1;
      if (!inserted) {
        const target = input.supersedes
          ? await this.getAsk(input.supersedes)
          : null;
        const own = target?.requesterId === requester.id;
        return {
          kind: "conflict",
          state: own ? (target?.ask.state ?? null) : null,
          message:
            own && target?.ask.decisionKey !== input.decisionKey
              ? "supersedes must name an Ask with the same decision key."
              : "supersedes must name your open Ask; it is closed or does not exist.",
        };
      }
    } catch (error) {
      if (isUniqueViolation(error, "asks.requester_id, asks.idem_key")) {
        const raced = await this.byIdemKey(requester.id, idemKey, contentHash);
        if (raced) return raced;
      }
      if (isUniqueViolation(error, "asks.requester_id, asks.decision_key")) {
        const open = await this.db
          .prepare(
            "SELECT id FROM asks WHERE requester_id = ? AND decision_key = ? AND state = 'open'",
          )
          .bind(requester.id, input.decisionKey)
          .first<{ id: string }>();
        return {
          kind: "conflict",
          state: "open",
          message: `Ask ${open?.id ?? "(unknown)"} is already open for this decision key; name it in supersedes to replace it.`,
        };
      }
      throw error;
    }
    const created = await this.getAsk(id);
    if (!created) throw new Error("created Ask is missing");
    return { kind: "created", ask: created.ask };
  }

  private async byIdemKey(
    requesterId: string,
    idemKey: string,
    contentHash: string,
  ): Promise<CreateResult | null> {
    const row = await this.db
      .prepare(
        "SELECT id, content_hash FROM asks WHERE requester_id = ? AND idem_key = ?",
      )
      .bind(requesterId, idemKey)
      .first<{ id: string; content_hash: string }>();
    if (!row) return null;
    if (row.content_hash !== contentHash)
      return {
        kind: "conflict",
        state: null,
        message:
          "This idempotency key was already used for an Ask with different content.",
      };
    const existing = await this.getAsk(row.id);
    return existing ? { kind: "existing", ask: existing.ask } : null;
  }

  // ---- Asks: transitions --------------------------------------------------

  /**
   * Moves an open Ask to `to` in one batch with its audit record. `guard` adds
   * conditions to the update; the audit insert runs only if the update did.
   */
  private async transition(
    id: string,
    to: Exclude<AskState, "open" | "answered">,
    actor: Actor,
    now: number,
    guard: { sql: string; values: unknown[] },
  ): Promise<boolean> {
    const [update] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE asks SET state = ?1, closed_at = ?2 WHERE id = ?3 AND state = 'open' ${guard.sql}`,
        )
        .bind(to, now, id, ...guard.values),
      this.db
        .prepare(
          `INSERT INTO ask_events (ask_id, requester_id, state, actor, at)
           SELECT id, requester_id, ?1, ?2, ?3 FROM asks WHERE id = ?4 AND changes() = 1`,
        )
        .bind(to, actorName(actor), now, id),
    ]);
    return update?.meta.changes === 1;
  }

  async withdraw(
    requesterId: string,
    id: string,
    now: number,
  ): Promise<TransitionResult> {
    const done = await this.transition(
      id,
      "withdrawn",
      { kind: "requester", id: requesterId },
      now,
      {
        sql: "AND requester_id = ?4",
        values: [requesterId],
      },
    );
    return this.after(id, done, "Only an open Ask can be withdrawn.");
  }

  /** Expires one Ask if it is open and past its expiry. */
  async expireIfDue(id: string, now: number): Promise<boolean> {
    return this.transition(id, "expired", { kind: "roger" }, now, {
      sql: "AND expires_at IS NOT NULL AND expires_at <= ?4",
      values: [now],
    });
  }

  async expireDue(now: number, limit: number): Promise<number> {
    const due = await this.db
      .prepare(
        `SELECT id FROM asks WHERE state = 'open' AND expires_at IS NOT NULL AND expires_at <= ?
         ORDER BY expires_at LIMIT ?`,
      )
      .bind(now, limit)
      .all<{ id: string }>();
    let expired = 0;
    for (const { id } of due.results)
      if (await this.expireIfDue(id, now)) expired++;
    return expired;
  }

  /**
   * Records an answer: the state change, the answer, and the audit record commit
   * together or not at all. Fails if the Ask is not open, is past its expiry, or
   * is addressed to someone else.
   */
  async answer(
    id: string,
    record: AnswerRecord,
    now: number,
  ): Promise<TransitionResult> {
    const [update] = await this.db.batch([
      this.db
        .prepare(
          `UPDATE asks SET state = 'answered', closed_at = ?1
           WHERE id = ?2 AND state = 'open' AND responder_id = ?3
             AND (expires_at IS NULL OR expires_at > ?1)`,
        )
        .bind(now, id, record.responder.githubId),
      this.db
        .prepare(
          `INSERT INTO answers (ask_id, option_id, option_label, decision, input, action,
             responder_id, responder, passkey_id, answered_at)
           SELECT id, ?2, ?3, ?4, ?5, action, ?6, ?7, ?8, ?9 FROM asks
           WHERE id = ?1 AND changes() = 1`,
        )
        .bind(
          id,
          record.option.id,
          record.option.label,
          record.option.decision,
          record.input,
          record.responder.githubId,
          record.responder.login,
          record.passkeyId,
          now,
        ),
      this.db
        .prepare(
          `INSERT INTO ask_events (ask_id, requester_id, state, actor, at)
           SELECT id, requester_id, 'answered', ?1, ?2 FROM asks WHERE id = ?3 AND changes() = 1`,
        )
        .bind(
          actorName({ kind: "responder", githubId: record.responder.githubId }),
          now,
          id,
        ),
    ]);
    const done = update?.meta.changes === 1;
    if (!done) await this.expireIfDue(id, now);
    return this.after(id, done, "This Ask is no longer open.");
  }

  private async after(
    id: string,
    done: boolean,
    conflict: string,
  ): Promise<TransitionResult> {
    const current = await this.getAsk(id);
    if (!current)
      return { kind: "conflict", state: null, message: "No such Ask." };
    return done
      ? { kind: "done", ask: current.ask }
      : { kind: "conflict", state: current.ask.state, message: conflict };
  }

  // ---- Trace --------------------------------------------------------------

  /**
   * Appends a requester event to an answered Ask. Appending implies the answer
   * was read, so `delivered` is recorded first if missing.
   */
  async appendTrace(
    id: string,
    entry: AppendTrace,
    now: number,
  ): Promise<TransitionResult> {
    const [, inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO trace (id, ask_id, event, at)
           SELECT ?1, ask_id, 'delivered', ?2 FROM answers WHERE ask_id = ?3`,
        )
        .bind(ulid(now), now, id),
      this.db
        .prepare(
          `INSERT INTO trace (id, ask_id, event, refs, url, note, at)
           SELECT ?1, ask_id, ?2, ?3, ?4, ?5, ?6 FROM answers WHERE ask_id = ?7
             AND NOT EXISTS (SELECT 1 FROM trace WHERE ask_id = ?7 AND event IN ${TERMINAL})
             AND (SELECT count(*) FROM trace WHERE ask_id = ?7) < ?8`,
        )
        .bind(
          ulid(now),
          entry.event,
          JSON.stringify(entry.refs ?? {}),
          entry.url ?? null,
          entry.note ?? null,
          now,
          id,
          LIMITS.traceEvents,
        ),
    ]);
    const current = await this.getAsk(id);
    if (!current)
      return { kind: "conflict", state: null, message: "No such Ask." };
    if (inserted?.meta.changes === 1) return { kind: "done", ask: current.ask };
    const { ask } = current;
    const message = !ask.answer
      ? "Only an answered Ask has a trace."
      : ask.trace.some(
            (t) =>
              t.event === "applied" ||
              t.event === "failed" ||
              t.event === "not_applicable",
          )
        ? "The trace already has a terminal event."
        : `The trace is full (${LIMITS.traceEvents} events).`;
    return { kind: "conflict", state: ask.state, message };
  }

  // ---- Inbox --------------------------------------------------------------

  async openFor(githubId: number, limit: number): Promise<Ask[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${ASK_COLUMNS} FROM ${ASK_FROM}
         WHERE a.responder_id = ? AND a.state = 'open'
         ORDER BY ${URGENCY_ORDER}, a.created_at LIMIT ?`,
      )
      .bind(githubId, limit)
      .all<AskRow>();
    return (await this.hydrate(rows.results)).map((s) => s.ask);
  }

  /** Answers not delivered, or delivered without a terminal event, past the requester's expected times. */
  async stalledFor(
    githubId: number,
    now: number,
    limit: number,
  ): Promise<Stalled[]> {
    const rows = await this.db
      .prepare(
        `SELECT ${ASK_COLUMNS}, d.at AS delivered_at FROM ${ASK_FROM}
         JOIN answers ans ON ans.ask_id = a.id
         LEFT JOIN trace d ON d.ask_id = a.id AND d.event = 'delivered'
         WHERE a.responder_id = ?1
           AND NOT EXISTS (SELECT 1 FROM trace t WHERE t.ask_id = a.id AND t.event IN ${TERMINAL})
           AND ((d.at IS NULL AND ans.answered_at + r.pickup_minutes * 60000 < ?2)
             OR (d.at IS NOT NULL AND d.at + r.completion_minutes * 60000 < ?2))
         ORDER BY ans.answered_at LIMIT ?3`,
      )
      .bind(githubId, now, limit)
      .all<AskRow & { delivered_at: number | null }>();
    const asks = await this.hydrate(rows.results);
    return asks.map((s, i) => ({
      ask: s.ask,
      reason:
        rows.results[i]?.delivered_at === null
          ? "not_delivered"
          : "not_finished",
    }));
  }

  /**
   * Closed Asks addressed to this person, most recently closed first. The
   * cursor is the last row's `(closedAt, id)`, so Asks closed in the same
   * millisecond are neither skipped nor repeated.
   */
  async historyFor(
    githubId: number,
    before: { closedAt: number; id: string } | null,
    limit: number,
  ): Promise<{ asks: Ask[]; next: string | null }> {
    const rows = await this.db
      .prepare(
        `SELECT ${ASK_COLUMNS} FROM ${ASK_FROM}
         WHERE a.responder_id = ?1 AND a.state <> 'open'
           AND (a.closed_at < ?2 OR (a.closed_at = ?2 AND a.id < ?3))
         ORDER BY a.closed_at DESC, a.id DESC LIMIT ?4`,
      )
      .bind(
        githubId,
        before?.closedAt ?? Number.MAX_SAFE_INTEGER,
        before?.id ?? "",
        limit + 1,
      )
      .all<AskRow>();
    const page = rows.results.slice(0, limit);
    const last = page.at(-1);
    return {
      asks: (await this.hydrate(page)).map((s) => s.ask),
      next:
        rows.results.length > limit && last && last.closed_at !== null
          ? `${last.closed_at}.${last.id}`
          : null,
    };
  }

  // ---- Notifications and upkeep --------------------------------------------

  /** Pushes due now, optionally only the one for `askId`. */
  async duePushes(
    now: number,
    limit: number,
    askId: string | null = null,
  ): Promise<PushJob[]> {
    const rows = await this.db
      .prepare(
        `SELECT a.id, a.title, a.urgency, a.risk, a.repo, r.name, p.ntfy_topic FROM ${ASK_FROM}
         WHERE a.state = 'open' AND a.pushed_at IS NULL AND a.push_due_at <= ?1
           AND p.ntfy_topic IS NOT NULL AND (?2 IS NULL OR a.id = ?2)
         ORDER BY a.push_due_at LIMIT ?3`,
      )
      .bind(now, askId, limit)
      .all<{
        id: string;
        title: string;
        urgency: Ask["urgency"];
        risk: Ask["risk"];
        repo: string | null;
        name: string;
        ntfy_topic: string;
      }>();
    return rows.results.map((r) => ({
      askId: r.id,
      title: r.title,
      urgency: r.urgency,
      risk: r.risk,
      repo: r.repo,
      requester: r.name,
      topic: r.ntfy_topic,
    }));
  }

  /** Claims a push so the creating request and the cron never both send it. */
  async claimPush(askId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE asks SET pushed_at = ? WHERE id = ? AND pushed_at IS NULL AND state = 'open'",
      )
      .bind(now, askId)
      .run();
    return result.meta.changes === 1;
  }

  async releasePush(askId: string): Promise<void> {
    await this.db
      .prepare("UPDATE asks SET pushed_at = NULL WHERE id = ?")
      .bind(askId)
      .run();
  }

  /** Responders with a push topic, and their open Asks for the digest. */
  async digestCandidates(): Promise<{ githubId: number; topic: string }[]> {
    const rows = await this.db
      .prepare(
        "SELECT github_id, ntfy_topic FROM responders WHERE ntfy_topic IS NOT NULL",
      )
      .all<{ github_id: number; ntfy_topic: string }>();
    return rows.results.map((r) => ({
      githubId: r.github_id,
      topic: r.ntfy_topic,
    }));
  }

  async claimDigest(
    githubId: number,
    day: string,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "INSERT OR IGNORE INTO digests (github_id, day, sent_at) VALUES (?, ?, ?)",
      )
      .bind(githubId, day, now)
      .run();
    return result.meta.changes === 1;
  }

  async releaseDigest(githubId: number, day: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM digests WHERE github_id = ? AND day = ?")
      .bind(githubId, day)
      .run();
  }

  /** Purges bodies and links of Asks closed more than 90 days ago, a bounded batch per call. */
  async purgeOldContent(now: number, limit: number): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE asks SET body = NULL, links = NULL WHERE id IN (
           SELECT id FROM asks WHERE closed_at < ? AND (body IS NOT NULL OR links IS NOT NULL)
           LIMIT ?)`,
      )
      .bind(now - RETENTION_MS, limit)
      .run();
    return result.meta.changes;
  }
}
