import { secret, sha256, ulid } from "./ids.ts";
import type { Requester, Responder } from "./store.ts";

export const SESSION_MS = 8 * 60 * 60_000;
export const CHALLENGE_MS = 5 * 60_000;

export type ChallengePurpose = "answer" | "register" | "step_up";

export interface Passkey {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface RequesterView {
  id: string;
  name: string;
  pickupMinutes: number;
  completionMinutes: number;
  createdBy: string | null;
  createdAt: number;
  disabledAt: number | null;
  tokens: { id: string; createdAt: number; revokedAt: number | null }[];
}

interface PasskeyRow {
  id: string;
  public_key: ArrayBuffer | number[];
  counter: number;
  transports: string;
  created_at: number;
  last_used_at: number | null;
}

function passkey(row: PasskeyRow): Passkey {
  return {
    id: row.id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: JSON.parse(row.transports) as string[],
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** People, sessions, passkeys, requesters, and agent tokens. */
export class Accounts {
  constructor(private readonly db: D1Database) {}

  /**
   * Records a sign-in. If another responder last held this login (GitHub
   * logins can be renamed and reused), that record loses it first.
   */
  async upsertResponder(who: Responder, now: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE responders SET login = login || '#' || github_id WHERE lower(login) = lower(?) AND github_id <> ?",
        )
        .bind(who.login, who.githubId),
      this.db
        .prepare(
          `INSERT INTO responders (github_id, login, created_at) VALUES (?, ?, ?)
           ON CONFLICT (github_id) DO UPDATE SET login = excluded.login`,
        )
        .bind(who.githubId, who.login, now),
    ]);
  }

  async ntfyTopic(githubId: number): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT ntfy_topic FROM responders WHERE github_id = ?")
      .bind(githubId)
      .first<{ ntfy_topic: string | null }>();
    return row?.ntfy_topic ?? null;
  }

  async setNtfyTopic(githubId: number, topic: string | null): Promise<void> {
    await this.db
      .prepare("UPDATE responders SET ntfy_topic = ? WHERE github_id = ?")
      .bind(topic, githubId)
      .run();
  }

  // ---- Sessions -----------------------------------------------------------

  /** Creates a session and returns the cookie value. Only its hash is stored. */
  async createSession(githubId: number, now: number): Promise<string> {
    const value = secret("");
    await this.db
      .prepare(
        "INSERT INTO sessions (id_hash, github_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .bind(await sha256(value), githubId, now, now + SESSION_MS)
      .run();
    return value;
  }

  async session(value: string, now: number): Promise<Responder | null> {
    const row = await this.db
      .prepare(
        `SELECT p.github_id, p.login FROM sessions s JOIN responders p ON p.github_id = s.github_id
         WHERE s.id_hash = ? AND s.expires_at > ?`,
      )
      .bind(await sha256(value), now)
      .first<{ github_id: number; login: string }>();
    return row ? { githubId: row.github_id, login: row.login } : null;
  }

  async endSession(value: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM sessions WHERE id_hash = ?")
      .bind(await sha256(value))
      .run();
  }

  // ---- Passkeys and challenges --------------------------------------------

  async passkeys(githubId: number): Promise<Passkey[]> {
    const rows = await this.db
      .prepare("SELECT * FROM passkeys WHERE github_id = ? ORDER BY created_at")
      .bind(githubId)
      .all<PasskeyRow>();
    return rows.results.map(passkey);
  }

  async passkey(githubId: number, id: string): Promise<Passkey | null> {
    const row = await this.db
      .prepare("SELECT * FROM passkeys WHERE github_id = ? AND id = ?")
      .bind(githubId, id)
      .first<PasskeyRow>();
    return row ? passkey(row) : null;
  }

  async addPasskey(
    githubId: number,
    key: Omit<Passkey, "lastUsedAt">,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO passkeys (id, github_id, public_key, counter, transports, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        key.id,
        githubId,
        key.publicKey,
        key.counter,
        JSON.stringify(key.transports),
        key.createdAt,
      )
      .run();
  }

  async usePasskey(
    githubId: number,
    id: string,
    counter: number,
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND github_id = ?",
      )
      .bind(counter, now, id, githubId)
      .run();
  }

  async createChallenge(
    githubId: number,
    purpose: ChallengePurpose,
    challenge: string,
    binding: unknown,
    now: number,
  ): Promise<string> {
    const id = ulid(now);
    await this.db
      .prepare(
        `INSERT INTO challenges (id, github_id, purpose, challenge, binding, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        githubId,
        purpose,
        challenge,
        JSON.stringify(binding),
        now + CHALLENGE_MS,
      )
      .run();
    return id;
  }

  /** Deletes and returns an unexpired challenge, so each is usable once. */
  async consumeChallenge(
    githubId: number,
    purpose: ChallengePurpose,
    challenge: string,
    now: number,
  ): Promise<{ binding: unknown } | null> {
    const row = await this.db
      .prepare(
        `DELETE FROM challenges WHERE github_id = ? AND purpose = ? AND challenge = ? AND expires_at > ?
         RETURNING binding`,
      )
      .bind(githubId, purpose, challenge, now)
      .first<{ binding: string }>();
    return row ? { binding: JSON.parse(row.binding) as unknown } : null;
  }

  // ---- Requesters and tokens ----------------------------------------------

  async requesterByToken(token: string): Promise<Requester | null> {
    const row = await this.db
      .prepare(
        `SELECT r.id, r.name, r.created_by FROM tokens t JOIN requesters r ON r.id = t.requester_id
         WHERE t.hash = ? AND t.revoked_at IS NULL AND r.disabled_at IS NULL`,
      )
      .bind(await sha256(token))
      .first<{ id: string; name: string; created_by: number }>();
    return row
      ? { id: row.id, name: row.name, createdBy: row.created_by }
      : null;
  }

  /**
   * The requesters `owner` created, enabled first, at most `limit`, each with
   * its 20 most recent tokens. `truncated` says whether more exist.
   */
  async requesters(
    owner: number,
    limit: number,
  ): Promise<{ requesters: RequesterView[]; truncated: boolean }> {
    const listed = await this.db
      .prepare(
        `SELECT r.*, p.login AS created_by_login FROM requesters r
         LEFT JOIN responders p ON p.github_id = r.created_by
         WHERE r.created_by = ?
         ORDER BY r.disabled_at IS NOT NULL, r.name LIMIT ?`,
      )
      .bind(owner, limit + 1)
      .all();
    const page = listed.results.slice(0, limit);
    const tokens = await this.db
      .prepare(
        `SELECT id, requester_id, created_at, revoked_at FROM (
           SELECT t.*, row_number() OVER (
             PARTITION BY requester_id ORDER BY created_at DESC) AS n
           FROM tokens t
           WHERE requester_id IN (SELECT value FROM json_each(?)))
         WHERE n <= 20 ORDER BY created_at`,
      )
      .bind(JSON.stringify(page.map((r) => r.id)))
      .all();
    type Row = {
      id: string;
      name: string;
      pickup_minutes: number;
      completion_minutes: number;
      created_by_login: string | null;
      created_at: number;
      disabled_at: number | null;
    };
    type TokenRow = {
      id: string;
      requester_id: string;
      created_at: number;
      revoked_at: number | null;
    };
    const byRequester = new Map<string, RequesterView["tokens"]>();
    for (const t of tokens.results as TokenRow[]) {
      const list = byRequester.get(t.requester_id) ?? [];
      list.push({ id: t.id, createdAt: t.created_at, revokedAt: t.revoked_at });
      byRequester.set(t.requester_id, list);
    }
    return {
      truncated: listed.results.length > limit,
      requesters: (page as Row[]).map((r) => ({
        id: r.id,
        name: r.name,
        pickupMinutes: r.pickup_minutes,
        completionMinutes: r.completion_minutes,
        createdBy: r.created_by_login,
        createdAt: r.created_at,
        disabledAt: r.disabled_at,
        tokens: byRequester.get(r.id) ?? [],
      })),
    };
  }

  /** Returns the new requester's id, or `null` if the name is taken. */
  async createRequester(
    name: string,
    pickupMinutes: number,
    completionMinutes: number,
    createdBy: number,
    now: number,
  ): Promise<string | null> {
    const id = ulid(now);
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO requesters (id, name, pickup_minutes, completion_minutes, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, name, pickupMinutes, completionMinutes, createdBy, now)
      .run();
    return result.meta.changes === 1 ? id : null;
  }

  /** Disables a requester owned by `owner`. */
  async disableRequester(
    id: string,
    owner: number,
    now: number,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE requesters SET disabled_at = ? WHERE id = ? AND created_by = ? AND disabled_at IS NULL",
      )
      .bind(now, id, owner)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * Issues a token for an enabled requester owned by `createdBy`. Only the
   * owner can, since Asks default to the owner. The value is returned once
   * and never stored.
   */
  async issueToken(
    requesterId: string,
    createdBy: number,
    now: number,
  ): Promise<{ id: string; token: string } | null> {
    const token = secret("roger_");
    const id = ulid(now);
    const result = await this.db
      .prepare(
        `INSERT INTO tokens (id, requester_id, hash, created_by, created_at)
         SELECT ?1, id, ?2, ?3, ?4 FROM requesters
         WHERE id = ?5 AND created_by = ?3 AND disabled_at IS NULL`,
      )
      .bind(id, await sha256(token), createdBy, now, requesterId)
      .run();
    return result.meta.changes === 1 ? { id, token } : null;
  }

  /** Revokes a token of a requester owned by `owner`. */
  async revokeToken(id: string, owner: number, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tokens SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL
           AND requester_id IN (SELECT id FROM requesters WHERE created_by = ?3)`,
      )
      .bind(now, id, owner)
      .run();
    return result.meta.changes === 1;
  }

  /** Deletes expired sessions and challenges, a bounded batch per call. */
  async sweep(now: number, limit: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM sessions WHERE id_hash IN (SELECT id_hash FROM sessions WHERE expires_at <= ? LIMIT ?)",
        )
        .bind(now, limit),
      this.db
        .prepare(
          "DELETE FROM challenges WHERE id IN (SELECT id FROM challenges WHERE expires_at <= ? LIMIT ?)",
        )
        .bind(now, limit),
    ]);
  }
}
