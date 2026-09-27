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
/** Logins in progress across everyone; more are refused until some expire. */
export const PENDING_LIMIT = 1_000;
/** Requesters one machine name can create on first use. */
export const MACHINE_REQUESTER_LIMIT = 100;
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
  constructor(private readonly db: D1Database) {}

  // ---- Device authorization (RFC 8628) -------------------------------------

  /**
   * Starts a login. Returns the two codes, which are stored only as hashes,
   * or `null` when too many logins are in progress.
   */
  async start(
    suggested: string | null,
    now: number,
  ): Promise<{ deviceCode: string; userCode: string } | null> {
    const deviceCode = secret("");
    const userCode = newUserCode();
    const result = await this.db
      .prepare(
        `INSERT INTO device_codes (id, device_hash, user_hash, suggested, interval_ms, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE (SELECT count(*) FROM device_codes WHERE expires_at > ?6) < ?8`,
      )
      .bind(
        ulid(now),
        await sha256(deviceCode),
        await sha256(normalizeUserCode(userCode)),
        suggested,
        POLL_INTERVAL_MS,
        now,
        now + DEVICE_CODE_MS,
        PENDING_LIMIT,
      )
      .run();
    return result.meta.changes === 1 ? { deviceCode, userCode } : null;
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

  private async issue(id: string, now: number): Promise<PollResult> {
    const credential = secret("rogm_");
    const machineId = ulid(now);
    let inserted: number;
    try {
      // One batch: the credential exists only if the code moved to `issued`,
      // and it replaces the owner's machine of the same name, as a repeated
      // `roger login` on one machine does.
      const [, insert] = await this.db.batch([
        this.db
          .prepare(
            `UPDATE machines SET revoked_at = ?1 WHERE revoked_at IS NULL
               AND (owner, name) = (SELECT owner, machine FROM device_codes
                                    WHERE id = ?2 AND state = 'approved' AND expires_at > ?1)`,
          )
          .bind(now, id),
        this.db
          .prepare(
            `INSERT INTO machines (id, name, owner, hash, created_at)
             SELECT ?1, machine, owner, ?2, ?3 FROM device_codes
             WHERE id = ?4 AND state = 'approved' AND expires_at > ?3`,
          )
          .bind(machineId, await sha256(credential), now, id),
        this.db
          .prepare(
            "UPDATE device_codes SET state = 'issued' WHERE id = ? AND state = 'approved'",
          )
          .bind(id),
      ]);
      inserted = insert?.meta.changes ?? 0;
    } catch (error) {
      // Someone else's machine took the name after this one was approved.
      if (String(error).includes("UNIQUE"))
        return {
          kind: "invalid",
          message:
            "Someone else logged in a machine with this name meanwhile. Log in again with another name.",
        };
      throw error;
    }
    if (inserted !== 1)
      return { kind: "invalid", message: "Unknown or used device code." };
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
  ): Promise<{
    suggested: string | null;
    createdAt: number;
    expiresAt: number;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT suggested, created_at, expires_at FROM device_codes
         WHERE user_hash = ? AND state = 'pending' AND expires_at > ?`,
      )
      .bind(await sha256(normalizeUserCode(userCode)), now)
      .first<{
        suggested: string | null;
        created_at: number;
        expires_at: number;
      }>();
    return row
      ? {
          suggested: row.suggested,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        }
      : null;
  }

  /**
   * Approves a pending login as `owner`'s machine `name`. A name belongs to
   * one person; the new login replaces that person's machine of the same
   * name once the CLI collects it.
   */
  async approve(
    userCode: string,
    owner: number,
    name: string,
    now: number,
  ): Promise<ApproveResult> {
    const taken = await this.db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM machines WHERE name = ?1 AND owner <> ?2)
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

  async byCredential(credential: string): Promise<Machine | null> {
    return this.db
      .prepare(
        "SELECT id, name, owner FROM machines WHERE hash = ? AND revoked_at IS NULL",
      )
      .bind(await sha256(credential))
      .first<Machine>();
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

  /** `owner`'s active machines, at most 50, each with its requesters. */
  async list(owner: number): Promise<MachineView[]> {
    const machines = await this.db
      .prepare(
        `SELECT id, name, created_at FROM machines WHERE owner = ? AND revoked_at IS NULL
         ORDER BY name LIMIT 50`,
      )
      .bind(owner)
      .all<{ id: string; name: string; created_at: number }>();
    const requesters = await this.db
      .prepare(
        `SELECT id, name, machine, disabled_at FROM requesters
         WHERE created_by = ? AND machine IN (SELECT value FROM json_each(?))
         ORDER BY disabled_at IS NOT NULL, name`,
      )
      .bind(owner, JSON.stringify(machines.results.map((m) => m.name)))
      .all<{
        id: string;
        name: string;
        machine: string;
        disabled_at: number | null;
      }>();
    return machines.results.map((m) => ({
      id: m.id,
      name: m.name,
      createdAt: m.created_at,
      requesters: requesters.results
        .filter((r) => r.machine === m.name)
        .map((r) => ({ id: r.id, name: r.name, disabledAt: r.disabled_at })),
    }));
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
   * Binds an enabled requester the owner created in Settings to this
   * machine, so `--as <name>` acts as it. Its tokens keep working.
   */
  async adopt(machine: Machine, name: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE requesters SET machine = ?
         WHERE name = ? AND created_by = ? AND machine IS NULL AND disabled_at IS NULL`,
      )
      .bind(machine.name, name, machine.owner)
      .run();
    return result.meta.changes === 1;
  }

  /** Deletes expired logins, a bounded batch per call. */
  async sweep(now: number, limit: number): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM device_codes WHERE id IN (SELECT id FROM device_codes WHERE expires_at <= ? LIMIT ?)",
      )
      .bind(now, limit)
      .run();
  }
}
