// @ts-check
// Which login the approval page may approve. Kept apart from the DOM so the
// rules are tested: an approval only ever names the code the person typed
// and whose lookup is the latest to finish, and any edit forgets it.

/** A user code as the Worker compares it: letters only, uppercase. @param {string} code */
export function normalizeCode(code) {
  return code.toUpperCase().replace(/[^A-Z]/g, "");
}

/** `BCDFGHJK` as `BCDF-GHJK`, as `roger login` prints it. @param {string} code */
export function formatCode(code) {
  const c = normalizeCode(code);
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/**
 * @template T
 * @typedef {{ kind: "ready", code: string, pending: T } | { kind: "failed", error: unknown } | { kind: "stale" }} LookupResult
 */

/**
 * @template T
 * @param {(code: string) => Promise<T>} lookup Looks up a normalized code.
 */
export function deviceApproval(lookup) {
  let generation = 0;
  /** @type {{ code: string, pending: T } | null} */
  let current = null;
  return {
    /** Forgets the looked-up login, as any edit of the code must. */
    edit() {
      generation += 1;
      current = null;
    },
    /**
     * Looks up `typed`. Only the latest lookup can make a login current;
     * an older one that finishes later is `stale`.
     * @param {string} typed
     * @returns {Promise<LookupResult<T>>}
     */
    async lookup(typed) {
      generation += 1;
      const mine = generation;
      current = null;
      const code = normalizeCode(typed);
      try {
        const pending = await lookup(code);
        if (mine !== generation) return { kind: "stale" };
        current = { code, pending };
        return { kind: "ready", code, pending };
      } catch (error) {
        return mine === generation
          ? { kind: "failed", error }
          : { kind: "stale" };
      }
    },
    /**
     * The login to approve or deny: the current one, only while the code in
     * the input still matches it.
     * @param {string} typed
     */
    target(typed) {
      return current && current.code === normalizeCode(typed) ? current : null;
    },
  };
}
