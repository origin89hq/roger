import {
  DEFAULT_COMPLETION_MINUTES,
  DEFAULT_PICKUP_MINUTES,
} from "./accounts.ts";
import { secret, sha256, ulid } from "./ids.ts";
import type { Requester } from "./store.ts";

/** How long a `roger login` has to be approved (RFC 8628 `expires_in`). */
export const DEVICE_CODE_MS = 15 * 60_000;
/** Poll interval the CLI starts with; each too-fast poll adds 5 seconds. */
export const POLL_INTERVAL_MS = 5_000;
/**
 * Logins waiting for approval across everyone; more are refused until some
 * expire. A backstop behind the per-source limit, far above real use.
 */
export const PENDING_LIMIT = 10_000;
/** Expired logins each new login deletes, so cleanup keeps pace with starts. */
const EXPIRED_PER_START = 10;
/** Requesters one machine name can have, created on first use or adopted. */
export const MACHINE_REQUESTER_LIMIT = 100;
/** Code lookups, approvals, and denials per person per window (RFC 8628 section 5.1). */
export const DEVICE_ATTEMPTS = 20;
export const DEVICE_ATTEMPT_WINDOW_MS = 15 * 60_000;
/** Machines per page in Settings. */
export const MACHINE_PAGE = 50;
/** Requester used when a machine call names no automation. */
export const DEFAULT_AUTOMATION = "default";

// RFC 8628 section 6.1: consonants only, so codes spell no words, 20^8 values.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** A machine credential that has not been revoked. */
export interface Machine {
  id: string;
  name: string;
  owner: number;
}

export interface MachineView {
  id: string;
  name: string;
  createdAt: number;
  requesters: { id: string; name: string; disabledAt: number | null }[];
}

/** Where a login was started, as the approval page shows it. */
export interface DeviceSource {
  /** IP address and country, such as `203.0.113.7 (CA)`. */
  source: string | null;
  userAgent: string | null;
}

export type PollResult =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "denied" }
  | { kind: "expired" }
  /** Unknown, already used, or no longer issuable. */
  | { kind: "invalid"; message: string }
  | { kind: "issued"; credential: string; machine: string; owner: string };

export type ApproveResult =
  | { kind: "approved" }
  | { kind: "not_found" }
  | { kind: "name_taken"; message: string };

export type AdoptResult =
  | { kind: "adopted"; machine: string }
  | { kind: "not_found" }
  | { kind: "conflict"; message: string }
  | { kind: "full"; message: string };

export type ResolveResult =
  | { kind: "ok"; requester: Requester }
  | { kind: "disabled"; name: string }
  | { kind: "refused"; message: string };

/** A user code as stored and compared: letters only, uppercase. */
export function normalizeUserCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z]/g, "");
}

function newUserCode(): string {
  let code = "";
  while (code.length < 8) {
    // 240 is the largest multiple of 20 below 256, so every letter is equally likely.
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 240 && code.length < 8)
        code += USER_CODE_ALPHABET.charAt(byte % 20);
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

interface DeviceRow {
  id: string;
  state: "pending" | "approved" | "denied" | "issued";
  interval_ms: number;
  polled_at: number | null;
  expires_at: number;
}

/** Device authorization, machine credentials, and the requesters they act as. */
export class Machines {
  constructor(
    private readonly db: D1Database,
    private readonly pendingLimit = PENDING_LIMIT,
  ) {}

  // ---- Device authorization (RFC 8628) -------------------------------------

  /**
   * Starts a login. Returns the two codes, which are stored only as hashes,
   * or `null` when too many logins are waiting. Each start first deletes a
   * few expired logins, so the table stays bounded by the start rate.
   */
  async start(
    suggested: string | null,
    from: DeviceSource,
    now: number,
  ): Promise<{ deviceCode: string; userCode: string } | null> {
    const deviceCode = secret("");
    const userCode = newUserCode();
    const [, insert] = await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM device_codes WHERE id IN (SELECT id FROM device_codes WHERE expires_at <= ? LIMIT ?)",
        )
        .bind(now, EXPIRED_PER_START),
      this.db
        .prepare(
          `INSERT INTO device_codes (id, device_hash, user_hash, suggested, source, user_agent, interval_ms, created_at, expires_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
           WHERE (SELECT count(*) FROM device_codes WHERE state = 'pending' AND expires_at > ?8) < ?10`,
        )
        .bind(
          ulid(now),
          await sha256(deviceCode),
          await sha256(normalizeUserCode(userCode)),
          suggested,
          from.source,
          from.userAgent,
          POLL_INTERVAL_MS,
          now,
          now + DEVICE_CODE_MS,
          this.pendingLimit,
        ),
    ]);
    return insert?.meta.changes === 1 ? { deviceCode, userCode } : null;
  }

  /**
   * One poll of the token endpoint. An approved code is exchanged for a new
   * machine credential exactly once.
   */
  async poll(deviceCode: string, now: number): Promise<PollResult> {
    const deviceHash = await sha256(deviceCode);
    const row = await this.db
      .prepare(
        "SELECT id, state, interval_ms, polled_at, expires_at FROM device_codes WHERE device_hash = ?",
      )
      .bind(deviceHash)
      .first<DeviceRow>();
    if (!row || row.state === "issued")
      return { kind: "invalid", message: "Unknown or used device code." };
    if (row.expires_at <= now) return { kind: "expired" };
    if (row.polled_at !== null && now - row.polled_at < row.interval_ms) {
      await this.db
        .prepare(
          "UPDATE device_codes SET interval_ms = interval_ms + ?, polled_at = ? WHERE id = ?",
        )
        .bind(POLL_INTERVAL_MS, now, row.id)
        .run();
      return { kind: "slow_down" };
    }
    await this.db
      .prepare("UPDATE device_codes SET polled_at = ? WHERE id = ?")
      .bind(now, row.id)
      .run();
    switch (row.state) {
      case "pending":
        return { kind: "pending" };
      case "denied":
        return { kind: "denied" };
      case "approved":
        return this.issue(row.id, now);
      default: {
        const unreachable: never = row.state;
        throw new Error(`unknown device state ${String(unreachable)}`);
      }
    }
  }

  /**
   * Exchanges an approved code for a credential, in one batch: the machine
   * row exists only if no one else holds the name, the code moves to
   * `issued` only if the row exists, and requesters left under the name by
   * a previous owner are renamed out of the way.
   */
  private async issue(id: string, now: number): Promise<PollResult> {
    const credential = secret("rogm_");
    const machineId = ulid(now);
    const [insert] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO machines (id, name, owner, hash, created_at)
           SELECT ?1, d.machine, d.owner, ?2, ?3 FROM device_codes d
           WHERE d.id = ?4 AND d.state = 'approved' AND d.expires_at > ?3
             AND NOT EXISTS (SELECT 1 FROM machines m WHERE m.name = d.machine
                               AND m.owner <> d.owner AND m.revoked_at IS NULL)`,
        )
        .bind(machineId, await sha256(credential), now, id),
      // `<name>/<job>` becomes `<name>/<job>#<requester id>`: unique, still
      // owned by the previous owner, and reachable through a token only.
      this.db
        .prepare(
          `UPDATE requesters
           SET name = CASE WHEN instr(name, '/') > 0 THEN name || '#' || id ELSE name END,
               machine = NULL
           WHERE machine = (SELECT name FROM machines WHERE id = ?1)
             AND created_by <> (SELECT owner FROM machines WHERE id = ?1)`,
        )
        .bind(machineId),
      this.db
        .prepare(
          `UPDATE device_codes SET state = 'issued'
           WHERE id = ? AND state = 'approved' AND EXISTS (SELECT 1 FROM machines WHERE id = ?)`,
        )
        .bind(id, machineId),
    ]);
    if (insert?.meta.changes !== 1) {
      const still = await this.db
        .prepare(
          "SELECT 1 AS approved FROM device_codes WHERE id = ? AND state = 'approved' AND expires_at > ?",
        )
        .bind(id, now)
        .first<{ approved: number }>();
      return {
        kind: "invalid",
        message: still
          ? "Someone else logged in a machine with this name meanwhile. Log in again with another name."
          : "Unknown or used device code.",
      };
    }
    const row = await this.db
      .prepare(
        "SELECT m.name, p.login FROM machines m JOIN responders p ON p.github_id = m.owner WHERE m.id = ?",
      )
      .bind(machineId)
      .first<{ name: string; login: string }>();
    if (!row) throw new Error("issued machine is missing");
    return { kind: "issued", credential, machine: row.name, owner: row.login };
  }

  /** A login waiting for approval, for the inbox to show before approving. */
  async pending(
    userCode: string,
    now: number,
  ): Promise<
    | (DeviceSource & {
        suggested: string | null;
        createdAt: number;
        expiresAt: number;
      })
    | null
  > {
    const row = await this.db
      .prepare(
        `SELECT suggested, source, user_agent, created_at, expires_at FROM device_codes
         WHERE user_hash = ? AND state = 'pending' AND expires_at > ?`,
      )
      .bind(await sha256(normalizeUserCode(userCode)), now)
      .first<{
        suggested: string | null;
        source: string | null;
        user_agent: string | null;
        created_at: number;
        expires_at: number;
      }>();
    return row
      ? {
          suggested: row.suggested,
          source: row.source,
          userAgent: row.user_agent,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        }
      : null;
  }

  /**
   * Records one attempt to look up, approve, or deny a user code. `false`
   * when the person has used up the window's attempts.
   */
  async attempt(githubId: number, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO device_attempts (id, github_id, at)
         SELECT ?1, ?2, ?3
         WHERE (SELECT count(*) FROM device_attempts WHERE github_id = ?2 AND at > ?4) < ?5`,
      )
      .bind(
        ulid(now),
        githubId,
        now,
        now - DEVICE_ATTEMPT_WINDOW_MS,
        DEVICE_ATTEMPTS,
      )
      .run();
    return result.meta.changes === 1;
  }

  /**
   * Approves a pending login as `owner`'s machine `name`. An active name
   * belongs to one person; a revoked one is free again. The new login
   * replaces that person's machine of the same name when first used.
   */
  async approve(
    userCode: string,
    owner: number,
    name: string,
    now: number,
  ): Promise<ApproveResult> {
    const taken = await this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM machines WHERE name = ?1 AND owner <> ?2 AND revoked_at IS NULL)
             OR EXISTS (SELECT 1 FROM device_codes WHERE machine = ?1 AND owner <> ?2
                          AND state = 'approved' AND expires_at > ?3) AS other`,
      )
      .bind(name, owner, now)
      .first<{ other: number }>();
    if (taken?.other)
      return {
        kind: "name_taken",
        message: `Someone else uses the machine name ${name}. Choose another.`,
      };
    const result = await this.db
      .prepare(
        `UPDATE device_codes SET state = 'approved', owner = ?, machine = ?
         WHERE user_hash = ? AND state = 'pending' AND expires_at > ?`,
      )
      .bind(owner, name, await sha256(normalizeUserCode(userCode)), now)
      .run();
    return result.meta.changes === 1
      ? { kind: "approved" }
      : { kind: "not_found" };
  }

  /** Denies a pending login; its next poll gets `access_denied`. */
  async deny(userCode: string, owner: number, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE device_codes SET state = 'denied', owner = ?
         WHERE user_hash = ? AND state = 'pending' AND expires_at > ?`,
      )
      .bind(owner, await sha256(normalizeUserCode(userCode)), now)
      .run();
    return result.meta.changes === 1;
  }

  // ---- Machine credentials --------------------------------------------------

  /**
   * The machine a credential belongs to. Its first use revokes the owner's
   * older machines of the same name, so a login that is never collected or
   * saved leaves the previous one working.
   */
  async byCredential(credential: string, now: number): Promise<Machine | null> {
    const row = await this.db
      .prepare(
        "SELECT id, name, owner, replacing FROM machines WHERE hash = ? AND revoked_at IS NULL",
      )
      .bind(await sha256(credential))
      .first<Machine & { replacing: number }>();
    if (!row) return null;
    if (row.replacing) {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE machines SET revoked_at = ?
             WHERE owner = ? AND name = ? AND id < ? AND revoked_at IS NULL`,
          )
          .bind(now, row.owner, row.name, row.id),
        this.db
          .prepare("UPDATE machines SET replacing = 0 WHERE id = ?")
          .bind(row.id),
      ]);
    }
    return { id: row.id, name: row.name, owner: row.owner };
  }

  /** Revokes a machine; with `owner`, only if that person owns it. */
  async revoke(id: string, owner: number, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE machines SET revoked_at = ? WHERE id = ? AND owner = ? AND revoked_at IS NULL",
      )
      .bind(now, id, owner)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * A page of `owner`'s active machines in login order, each with its
   * requesters (at most 100 each). `next` continues the list.
   */
  async list(
    owner: number,
    after: string | null,
  ): Promise<{ machines: MachineView[]; next: string | null }> {
    const listed = await this.db
      .prepare(
        `SELECT id, name, created_at FROM machines
         WHERE owner = ? AND revoked_at IS NULL AND id > ?
         ORDER BY id LIMIT ?`,
      )
      .bind(owner, after ?? "", MACHINE_PAGE + 1)
      .all<{ id: string; name: string; created_at: number }>();
    const page = listed.results.slice(0, MACHINE_PAGE);
    const requesters = await this.db
      .prepare(
        `SELECT id, name, machine, disabled_at FROM requesters
         WHERE created_by = ? AND machine IN (SELECT value FROM json_each(?))
         ORDER BY disabled_at IS NOT NULL, name`,
      )
      .bind(owner, JSON.stringify([...new Set(page.map((m) => m.name))]))
      .all<{
        id: string;
        name: string;
        machine: string;
        disabled_at: number | null;
      }>();
    return {
      next:
        listed.results.length > MACHINE_PAGE ? (page.at(-1)?.id ?? null) : null,
      machines: page.map((m) => ({
        id: m.id,
        name: m.name,
        createdAt: m.created_at,
        requesters: requesters.results
          .filter((r) => r.machine === m.name)
          .map((r) => ({ id: r.id, name: r.name, disabledAt: r.disabled_at })),
      })),
    };
  }

  // ---- Requesters of a machine -----------------------------------------------

  /**
   * The requester a machine acts as for `automation`: one the owner adopted
   * to this machine under that exact name, else `<machine>/<automation>`,
   * created on first use.
   */
  async requester(
    machine: Machine,
    automation: string,
    now: number,
  ): Promise<ResolveResult> {
    const full = `${machine.name}/${automation}`;
    const find = () =>
      this.db
        .prepare(
          `SELECT id, name, created_by, machine, disabled_at FROM requesters
           WHERE (name = ?1 AND created_by = ?3 AND machine = ?4) OR name = ?2
           ORDER BY name = ?2 LIMIT 1`,
        )
        .bind(automation, full, machine.owner, machine.name)
        .first<{
          id: string;
          name: string;
          created_by: number;
          machine: string | null;
          disabled_at: number | null;
        }>();
    let row = await find();
    if (!row) {
      await this.db
        .prepare(
          `INSERT INTO requesters (id, name, pickup_minutes, completion_minutes, created_by, created_at, machine)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
           WHERE (SELECT count(*) FROM requesters WHERE created_by = ?5 AND machine = ?7) < ?8
           ON CONFLICT (name) DO NOTHING`,
        )
        .bind(
          ulid(now),
          full,
          DEFAULT_PICKUP_MINUTES,
          DEFAULT_COMPLETION_MINUTES,
          machine.owner,
          now,
          machine.name,
          MACHINE_REQUESTER_LIMIT,
        )
        .run();
      row = await find();
    }
    if (!row)
      return {
        kind: "refused",
        message: `Machine ${machine.name} already has ${MACHINE_REQUESTER_LIMIT} requesters.`,
      };
    if (row.created_by !== machine.owner || row.machine !== machine.name)
      return {
        kind: "refused",
        message: `The requester ${row.name} belongs to someone else.`,
      };
    if (row.disabled_at !== null) return { kind: "disabled", name: row.name };
    return {
      kind: "ok",
      requester: { id: row.id, name: row.name, createdBy: row.created_by },
    };
  }

  /**
   * Binds an enabled requester `owner` created in Settings to their active
   * machine, so `--as <name>` there acts as it. Its tokens keep working.
   * Refused when the machine already has `<machine>/<name>`, whose Asks
   * would become unreachable, or already has its 100 requesters.
   */
  async adopt(
    requesterId: string,
    machineId: string,
    owner: number,
  ): Promise<AdoptResult> {
    const result = await this.db
      .prepare(
        `UPDATE requesters SET machine = m.name
         FROM (SELECT name FROM machines WHERE id = ?1 AND owner = ?3 AND revoked_at IS NULL) AS m
         WHERE requesters.id = ?2 AND requesters.created_by = ?3
           AND requesters.machine IS NULL AND requesters.disabled_at IS NULL
           AND instr(requesters.name, '/') = 0
           AND NOT EXISTS (SELECT 1 FROM requesters x WHERE x.name = m.name || '/' || requesters.name)
           AND (SELECT count(*) FROM requesters x WHERE x.created_by = ?3 AND x.machine = m.name) < ?4
         RETURNING machine`,
      )
      .bind(machineId, requesterId, owner, MACHINE_REQUESTER_LIMIT)
      .first<{ machine: string }>();
    if (result) return { kind: "adopted", machine: result.machine };
    // Nothing changed; say why.
    const why = await this.db
      .prepare(
        `SELECT m.name AS machine, r.name AS requester,
           EXISTS (SELECT 1 FROM requesters x WHERE x.name = m.name || '/' || r.name) AS conflict,
           (SELECT count(*) FROM requesters x WHERE x.created_by = ?3 AND x.machine = m.name) AS used
         FROM machines m, requesters r
         WHERE m.id = ?1 AND m.owner = ?3 AND m.revoked_at IS NULL
           AND r.id = ?2 AND r.created_by = ?3 AND r.machine IS NULL
           AND r.disabled_at IS NULL AND instr(r.name, '/') = 0`,
      )
      .bind(machineId, requesterId, owner)
      .first<{
        machine: string;
        requester: string;
        conflict: number;
        used: number;
      }>();
    if (!why) return { kind: "not_found" };
    if (why.conflict)
      return {
        kind: "conflict",
        message: `${why.machine} already has the requester ${why.machine}/${why.requester}; adopting ${why.requester} would hide its Asks.`,
      };
    if (why.used >= MACHINE_REQUESTER_LIMIT)
      return {
        kind: "full",
        message: `${why.machine} already has ${MACHINE_REQUESTER_LIMIT} requesters.`,
      };
    return { kind: "not_found" };
  }

  /** Unbinds a requester `owner` adopted, so it is again reachable by token only. */
  async release(requesterId: string, owner: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE requesters SET machine = NULL
         WHERE id = ? AND created_by = ? AND machine IS NOT NULL AND instr(name, '/') = 0`,
      )
      .bind(requesterId, owner)
      .run();
    return result.meta.changes === 1;
  }

  /** Deletes expired logins and old attempts, a bounded batch of each per call. */
  async sweep(now: number, limit: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM device_codes WHERE id IN (SELECT id FROM device_codes WHERE expires_at <= ? LIMIT ?)",
        )
        .bind(now, limit),
      this.db
        .prepare(
          "DELETE FROM device_attempts WHERE id IN (SELECT id FROM device_attempts WHERE at <= ? LIMIT ?)",
        )
        .bind(now - DEVICE_ATTEMPT_WINDOW_MS, limit),
    ]);
  }
}
