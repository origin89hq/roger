import {
  DEFAULT_COMPLETION_MINUTES,
  DEFAULT_PICKUP_MINUTES,
} from "./accounts.ts";
import { secret, sha256, ulid } from "./ids.ts";
import type { Requester } from "./store.ts";

/** Requesters one machine name can have, created on first use or adopted. */
export const MACHINE_REQUESTER_LIMIT = 100;
/** Machines per page in Settings. */
export const MACHINE_PAGE = 50;
/** Requester used when a machine call names no automation. */
export const DEFAULT_AUTOMATION = "default";

/** A machine credential that has not been revoked. */
export interface Machine {
  id: string;
  name: string;
  owner: number;
}

export interface MachineView {
  id: string;
  name: string;
  /** IP address and country of the login. */
  source: string;
  userAgent: string | null;
  createdAt: number;
  requesters: { id: string; name: string; disabledAt: number | null }[];
}

export type IssueResult =
  | { kind: "issued"; credential: string }
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

/** Machine credentials and the requesters they act as. */
export class Machines {
  constructor(private readonly db: D1Database) {}

  /**
   * Issues a credential for `owner`'s machine `name`, after `roger login`
   * proved who the owner is. In one batch: the machine row exists only if no
   * one else holds the name, its generation is one more than any earlier
   * login of that name by the owner, and requesters left under the name by a
   * previous owner are renamed out of the way. The credential is returned
   * once; only its hash is stored.
   */
  async issue(
    owner: number,
    name: string,
    from: { source: string; userAgent: string | null },
    now: number,
  ): Promise<IssueResult> {
    const credential = secret("rogm_");
    const machineId = ulid(now);
    const [insert] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO machines (id, name, owner, hash, generation, source, user_agent, created_at)
           SELECT ?1, ?2, ?3, ?4,
                  1 + coalesce((SELECT max(generation) FROM machines g
                                WHERE g.owner = ?3 AND g.name = ?2), 0),
                  ?6, ?7, ?5
           WHERE NOT EXISTS (SELECT 1 FROM machines m WHERE m.name = ?2
                               AND m.owner <> ?3 AND m.revoked_at IS NULL)`,
        )
        .bind(
          machineId,
          name,
          owner,
          await sha256(credential),
          now,
          from.source,
          from.userAgent,
        ),
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
    ]);
    return insert?.meta.changes === 1
      ? { kind: "issued", credential }
      : {
          kind: "name_taken",
          message: `Someone else has a machine named ${name} logged in. Choose another name with --machine.`,
        };
  }

  // ---- Machine credentials --------------------------------------------------

  /**
   * The machine a credential belongs to. Its first use revokes the owner's
   * earlier generations of the same name, so a login that is never collected
   * or saved leaves the previous one working. Generations come from the
   * database, not from ids, which only increase within one isolate.
   */
  async byCredential(credential: string, now: number): Promise<Machine | null> {
    const row = await this.db
      .prepare(
        "SELECT id, name, owner, generation, replacing FROM machines WHERE hash = ? AND revoked_at IS NULL",
      )
      .bind(await sha256(credential))
      .first<Machine & { generation: number; replacing: number }>();
    if (!row) return null;
    if (row.replacing) {
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE machines SET revoked_at = ?
             WHERE owner = ? AND name = ? AND generation < ? AND revoked_at IS NULL`,
          )
          .bind(now, row.owner, row.name, row.generation),
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
        `SELECT id, name, source, user_agent, created_at FROM machines
         WHERE owner = ? AND revoked_at IS NULL AND id > ?
         ORDER BY id LIMIT ?`,
      )
      .bind(owner, after ?? "", MACHINE_PAGE + 1)
      .all<{
        id: string;
        name: string;
        source: string;
        user_agent: string | null;
        created_at: number;
      }>();
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
        source: m.source,
        userAgent: m.user_agent,
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
}
