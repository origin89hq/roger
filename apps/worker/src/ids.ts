const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

/**
 * A ULID. Ids made in the same millisecond by this isolate increase, so trace
 * entries recorded together keep their order.
 */
export function ulid(now: number): string {
  let random: Uint8Array;
  if (now <= lastTime) {
    random = increment(lastRandom);
    now = lastTime;
  } else {
    random = crypto.getRandomValues(new Uint8Array(10));
  }
  lastTime = now;
  lastRandom = random;
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let bits = 0;
  let value = 0;
  let rest = "";
  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rest += CROCKFORD.charAt((value >> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  return time + rest;
}

function increment(bytes: Uint8Array): Uint8Array {
  const next = bytes.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const byte = next[i] ?? 0;
    if (byte < 255) {
      next[i] = byte + 1;
      return next;
    }
    next[i] = 0;
  }
  return next;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 32 random bytes as base64url, with a prefix naming what the secret is for. */
export function secret(prefix: string): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** JSON with object keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}
