import { describe, expect, it } from "vitest";
import {
  addWorkingMinutes,
  type ConfigEnv,
  isWorkingTime,
  readConfig,
  readSchedule,
  type Schedule,
} from "../src/config.ts";

/** An instant given as Toronto wall-clock time during daylight saving (UTC-4). */
const toronto = (local: string) => Date.parse(`${local}-04:00`);

function schedule(): Schedule {
  const s = readSchedule("America/Toronto", "08:00-18:00", "mon-fri");
  if (typeof s === "string") throw new Error(s);
  return s;
}

const ENV: ConfigEnv = {
  APP_ORIGIN: "https://roger.origin89.com",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  GITHUB_ORG: "origin89hq",
  GITHUB_TEAM: "roger-responders",
  NTFY_URL: "https://ntfy.sh",
  TIME_ZONE: "America/Toronto",
  WORK_DAYS: "mon-fri",
  WORK_HOURS: "08:00-18:00",
};

describe("readSchedule", () => {
  it("reads hours as minutes and days as weekday numbers", () => {
    expect(readSchedule("Europe/Paris", "09:30-17:15", "mon,wed-fri")).toEqual({
      timeZone: "Europe/Paris",
      start: 9 * 60 + 30,
      end: 17 * 60 + 15,
      days: new Set([1, 3, 4, 5]),
    });
    expect(readSchedule("UTC", "00:00-24:00", "SUN-SAT")).toMatchObject({
      start: 0,
      end: 24 * 60,
      days: new Set([0, 1, 2, 3, 4, 5, 6]),
    });
  });

  it("rejects an unknown time zone", () => {
    expect(readSchedule("Mars/Olympus", "08:00-18:00", "mon-fri")).toContain(
      "TIME_ZONE",
    );
  });

  it("rejects malformed or inverted hours", () => {
    for (const hours of [
      "8:00-18:00",
      "08:00",
      "18:00-08:00",
      "08:00-08:00",
      "08:60-18:00",
      "08:00-24:01",
      "25:00-26:00",
    ]) {
      expect(readSchedule("UTC", hours, "mon-fri"), hours).toContain(
        "WORK_HOURS",
      );
    }
  });

  it("rejects unknown or backwards days", () => {
    for (const days of ["", "funday", "fri-mon", "mon-", "monday"]) {
      expect(readSchedule("UTC", "08:00-18:00", days), days).toContain(
        "WORK_DAYS",
      );
    }
  });
});

describe("readConfig", () => {
  it("reads a valid environment", () => {
    const config = readConfig({
      ...ENV,
      NTFY_URL: "https://ntfy.example.com/",
      NTFY_TOKEN: "tk",
    });
    expect(config).toMatchObject({
      origin: "https://roger.origin89.com",
      rpId: "roger.origin89.com",
      github: {
        clientId: "id",
        clientSecret: "secret",
        org: "origin89hq",
        team: "roger-responders",
      },
      ntfy: { url: "https://ntfy.example.com", token: "tk" },
      schedule: { timeZone: "America/Toronto", start: 480, end: 1080 },
    });
  });

  it("disables pushes when NTFY_URL is empty", () => {
    expect(readConfig({ ...ENV, NTFY_URL: "" })).toMatchObject({ ntfy: null });
  });

  it("allows plain http only on localhost", () => {
    expect(
      readConfig({ ...ENV, APP_ORIGIN: "http://localhost:8792" }),
    ).toMatchObject({
      origin: "http://localhost:8792",
      rpId: "localhost",
    });
  });

  it("rejects a bad APP_ORIGIN", () => {
    for (const origin of [
      "not a url",
      "https://roger.test/inbox",
      "https://roger.test/",
      "http://roger.test",
    ]) {
      expect(readConfig({ ...ENV, APP_ORIGIN: origin }), origin).toEqual(
        expect.stringContaining("APP_ORIGIN"),
      );
    }
  });

  it("rejects a non-https NTFY_URL", () => {
    for (const url of ["http://ntfy.sh", "ntfy.sh", "https://"]) {
      expect(readConfig({ ...ENV, NTFY_URL: url }), url).toBe(
        "NTFY_URL must be an https URL",
      );
    }
  });

  it("rejects missing GitHub settings and bad schedules", () => {
    const { GITHUB_CLIENT_SECRET: _, ...noSecret } = ENV;
    expect(readConfig(noSecret)).toEqual(
      expect.stringContaining("GITHUB_CLIENT_SECRET"),
    );
    expect(readConfig({ ...ENV, GITHUB_TEAM: "" })).toEqual(
      expect.stringContaining("GITHUB_TEAM"),
    );
    expect(readConfig({ ...ENV, TIME_ZONE: "Nowhere/City" })).toEqual(
      expect.stringContaining("TIME_ZONE"),
    );
    expect(readConfig({ ...ENV, WORK_HOURS: "18:00-08:00" })).toEqual(
      expect.stringContaining("WORK_HOURS"),
    );
    expect(readConfig({ ...ENV, WORK_DAYS: "sat-sun,xyz" })).toEqual(
      expect.stringContaining("WORK_DAYS"),
    );
  });
});

describe("isWorkingTime", () => {
  const s = schedule();
  it("includes the start and excludes the end of the day", () => {
    expect(isWorkingTime(toronto("2026-09-28T07:59:59"), s)).toBe(false);
    expect(isWorkingTime(toronto("2026-09-28T08:00:00"), s)).toBe(true);
    expect(isWorkingTime(toronto("2026-09-28T17:59:59"), s)).toBe(true);
    expect(isWorkingTime(toronto("2026-09-28T18:00:00"), s)).toBe(false);
  });

  it("excludes the weekend", () => {
    expect(isWorkingTime(toronto("2026-09-26T10:00:00"), s)).toBe(false);
    expect(isWorkingTime(toronto("2026-09-27T10:00:00"), s)).toBe(false);
    expect(isWorkingTime(toronto("2026-09-25T10:00:00"), s)).toBe(true);
  });

  it("uses the configured time zone, not UTC", () => {
    // 13:00 UTC on Monday is 09:00 in Toronto but 22:00 in Tokyo.
    const instant = Date.parse("2026-09-28T13:00:00Z");
    expect(isWorkingTime(instant, s)).toBe(true);
    const tokyo = readSchedule("Asia/Tokyo", "08:00-18:00", "mon-fri");
    if (typeof tokyo === "string") throw new Error(tokyo);
    expect(isWorkingTime(instant, tokyo)).toBe(false);
  });
});

describe("addWorkingMinutes", () => {
  const s = schedule();
  const cases: [string, string, number, string][] = [
    ["within a day", "2026-09-28T10:00:00", 30, "2026-09-28T10:30:00"],
    [
      "up to the end of the day",
      "2026-09-28T17:00:00",
      60,
      "2026-09-28T18:00:00",
    ],
    ["across the evening", "2026-09-28T17:30:00", 60, "2026-09-29T08:30:00"],
    ["across a weekend", "2026-09-25T17:30:00", 60, "2026-09-28T08:30:00"],
    ["from the night", "2026-09-29T02:00:00", 15, "2026-09-29T08:15:00"],
    ["from before the start", "2026-09-29T07:45:00", 30, "2026-09-29T08:30:00"],
    ["from a Saturday", "2026-09-26T12:00:00", 10, "2026-09-28T08:10:00"],
    [
      "with seconds carried over the night",
      "2026-09-28T17:59:30",
      1,
      "2026-09-29T08:00:30",
    ],
    [
      "over several days",
      "2026-09-28T08:00:00",
      3 * 600 + 5,
      "2026-10-01T08:05:00",
    ],
  ];
  for (const [name, from, n, expected] of cases) {
    it(`counts ${name}`, () => {
      expect(
        new Date(addWorkingMinutes(toronto(from), n, s)).toISOString(),
      ).toBe(new Date(toronto(expected)).toISOString());
    });
  }

  it("returns the same instant for zero minutes, even at night", () => {
    const night = toronto("2026-09-26T03:00:00");
    expect(addWorkingMinutes(night, 0, s)).toBe(night);
  });
});
