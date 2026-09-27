export interface Schedule {
  timeZone: string;
  /** Minutes after local midnight when the working day starts. */
  start: number;
  /** Minutes after local midnight when it ends; greater than `start`. */
  end: number;
  /** Working weekdays, 0 = Sunday. */
  days: ReadonlySet<number>;
}

export interface Config {
  /** Where the inbox is served, such as `https://roger.origin89.com`. */
  origin: string;
  /** WebAuthn relying-party id: the origin's host name. */
  rpId: string;
  github: { clientId: string; clientSecret: string; org: string; team: string };
  /** `null` disables pushes. */
  ntfy: { url: string; token: string | null } | null;
  schedule: Schedule;
}

export interface ConfigEnv {
  APP_ORIGIN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_ORG: string;
  GITHUB_TEAM: string;
  NTFY_URL: string;
  NTFY_TOKEN?: string;
  TIME_ZONE: string;
  WORK_DAYS: string;
  WORK_HOURS: string;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Reads the Worker's configuration, or explains the first problem found. */
export function readConfig(env: ConfigEnv): Config | string {
  let origin: URL;
  try {
    origin = new URL(env.APP_ORIGIN);
  } catch {
    return "APP_ORIGIN is not a URL";
  }
  if (origin.origin !== env.APP_ORIGIN)
    return "APP_ORIGIN must be an origin without a path";
  if (origin.protocol !== "https:" && origin.hostname !== "localhost")
    return "APP_ORIGIN must use https";
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
    return "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required";
  if (!env.GITHUB_ORG || !env.GITHUB_TEAM)
    return "GITHUB_ORG and GITHUB_TEAM are required";
  const schedule = readSchedule(env.TIME_ZONE, env.WORK_HOURS, env.WORK_DAYS);
  if (typeof schedule === "string") return schedule;
  let ntfy: Config["ntfy"] = null;
  if (env.NTFY_URL) {
    if (!URL.canParse(env.NTFY_URL) || !env.NTFY_URL.startsWith("https://"))
      return "NTFY_URL must be an https URL";
    ntfy = {
      url: env.NTFY_URL.replace(/\/+$/, ""),
      token: env.NTFY_TOKEN || null,
    };
  }
  return {
    origin: origin.origin,
    rpId: origin.hostname,
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      org: env.GITHUB_ORG,
      team: env.GITHUB_TEAM,
    },
    ntfy,
    schedule,
  };
}

export function readSchedule(
  timeZone: string,
  hours: string,
  days: string,
): Schedule | string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    return `TIME_ZONE "${timeZone}" is not a known time zone`;
  }
  const h = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(hours);
  const minute = (hh: string | undefined, mm: string | undefined) =>
    Number(hh) * 60 + Number(mm);
  const start = minute(h?.[1], h?.[2]);
  const end = minute(h?.[3], h?.[4]);
  if (
    !h ||
    Number(h[2]) > 59 ||
    Number(h[4]) > 59 ||
    !(start < end) ||
    end > 24 * 60
  )
    return `WORK_HOURS "${hours}" must look like 08:00-18:00 with the start before the end`;
  const set = new Set<number>();
  for (const part of days.toLowerCase().split(",")) {
    const [from = "", to = from] = part.trim().split("-");
    const a = WEEKDAYS.indexOf(from);
    const b = WEEKDAYS.indexOf(to);
    if (a < 0 || b < 0 || b < a)
      return `WORK_DAYS "${days}" must look like mon-fri or mon,wed`;
    for (let d = a; d <= b; d++) set.add(d);
  }
  return { timeZone, start, end, days: set };
}

interface LocalClock {
  weekday: number;
  minute: number;
  date: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function localClock(instant: number, timeZone: string): LocalClock {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const p of format.formatToParts(instant)) parts[p.type] = p.value;
  return {
    weekday: WEEKDAYS.indexOf((parts.weekday ?? "").toLowerCase()),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function isWorkingTime(instant: number, s: Schedule): boolean {
  const c = localClock(instant, s.timeZone);
  return s.days.has(c.weekday) && c.minute >= s.start && c.minute < s.end;
}

const MINUTE = 60_000;

/**
 * The instant `minutes` of working time after `from`. Time outside working
 * hours does not count, so an Ask created at night starts counting in the
 * morning. Around a daylight-saving change the result can be off by the shift.
 */
export function addWorkingMinutes(
  from: number,
  minutes: number,
  s: Schedule,
): number {
  let t = from;
  let remaining = minutes * MINUTE;
  // Each pass consumes a working window or skips to the next one: at most
  // three passes per calendar day, and the span in days follows from the
  // working minutes per week.
  const perWeek = (s.end - s.start) * s.days.size;
  const maxPasses = 3 * (Math.ceil((minutes / perWeek) * 7) + 7);
  for (let pass = 0; pass < maxPasses; pass++) {
    if (remaining <= 0) return t;
    const c = localClock(t, s.timeZone);
    const intoMinute = t % MINUTE;
    if (s.days.has(c.weekday) && c.minute >= s.start && c.minute < s.end) {
      const step = Math.min(
        (s.end - c.minute) * MINUTE - intoMinute,
        remaining,
      );
      t += step;
      remaining -= step;
    } else if (s.days.has(c.weekday) && c.minute < s.start) {
      t += (s.start - c.minute) * MINUTE - intoMinute;
    } else {
      t += (24 * 60 - c.minute + s.start) * MINUTE - intoMinute;
    }
  }
  throw new Error("working-time calculation did not converge");
}
