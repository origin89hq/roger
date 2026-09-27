import { describe, expect, it } from "vitest";
import type { Ask } from "../src/protocol.gen.ts";
import {
  agent,
  count,
  createAsk,
  errorOf,
  minutes,
  person,
  readAsk,
  reject,
  requester,
  services,
  type TestServices,
} from "./helpers.ts";

const EVIDENCE = "https://github.com/origin89hq/roger/commit/5d6e7f8";

/** An answered Ask and its requester's token. */
async function answered(svc: TestServices) {
  const me = await person(svc);
  const bot = await requester(svc, me);
  const ask = await createAsk(svc, bot.token);
  await reject(svc, me.cookie, ask.id);
  return { token: bot.token, id: ask.id };
}

function trace(svc: TestServices, token: string, id: string, body: unknown) {
  return agent(svc, token, "POST", `/v1/asks/${id}/trace`, body);
}

describe("appending to the trace", () => {
  it("refuses a trace on an open Ask", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    const response = await trace(svc, bot.token, ask.id, {
      event: "dispatched",
    });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "conflict",
      state: "open",
    });
    expect(await count("trace", "ask_id = ?", ask.id)).toBe(0);
  });

  it("refuses a trace on a withdrawn Ask", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const ask = await createAsk(svc, bot.token);
    await agent(svc, bot.token, "POST", `/v1/asks/${ask.id}/withdraw`);
    const response = await trace(svc, bot.token, ask.id, {
      event: "not_applicable",
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).state).toBe("withdrawn");
  });

  it("records `delivered` before the first reported event", async () => {
    const svc = services();
    const { token, id } = await answered(svc);
    svc.clock.now += minutes(2);
    const refs = {
      "orca.run": "r_81",
      "orca.task": "t_3",
      branch: "feat/follow-pr",
    };
    const response = await trace(svc, token, id, { event: "dispatched", refs });
    expect(response.status).toBe(200);
    const ask = await response.json<Ask>();
    expect(ask.trace.map((t) => [t.event, t.refs, t.at])).toEqual([
      ["delivered", {}, svc.clock.now],
      ["dispatched", refs, svc.clock.now],
    ]);
  });

  it("keeps `delivered` from an earlier read", async () => {
    const svc = services();
    const { token, id } = await answered(svc);
    const readAt = svc.clock.now;
    await readAsk(svc, token, id);
    svc.clock.now += minutes(5);
    const ask = await (
      await trace(svc, token, id, { event: "applied", url: EVIDENCE })
    ).json<Ask>();
    expect(ask.trace.map((t) => [t.event, t.url, t.at])).toEqual([
      ["delivered", null, readAt],
      ["applied", EVIDENCE, svc.clock.now],
    ]);
  });

  it("requires a url for `applied`", async () => {
    const svc = services();
    const { token, id } = await answered(svc);
    const response = await trace(svc, token, id, { event: "applied" });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("url");
    expect(await count("trace", "ask_id = ?", id)).toBe(0);
  });

  it("requires a url and a note for `failed`", async () => {
    const svc = services();
    const { token, id } = await answered(svc);
    expect(
      (await trace(svc, token, id, { event: "failed", url: EVIDENCE })).status,
    ).toBe(400);
    expect(
      (await trace(svc, token, id, { event: "failed", note: "conflicts" }))
        .status,
    ).toBe(400);
    const ok = await trace(svc, token, id, {
      event: "failed",
      url: EVIDENCE,
      note: "conflicts",
    });
    expect(ok.status).toBe(200);
    expect((await ok.json<Ask>()).trace.at(-1)).toMatchObject({
      event: "failed",
      url: EVIDENCE,
      note: "conflicts",
    });
  });

  it("refuses every event after a terminal one", async () => {
    const svc = services();
    const { token, id } = await answered(svc);
    expect(
      (
        await trace(svc, token, id, {
          event: "not_applicable",
          note: "head moved",
        })
      ).status,
    ).toBe(200);
    for (const body of [
      { event: "progress" },
      { event: "dispatched" },
      { event: "applied", url: EVIDENCE },
      { event: "not_applicable" },
    ]) {
      const response = await trace(svc, token, id, body);
      expect(response.status, body.event).toBe(409);
      expect((await errorOf(response)).message).toContain("terminal");
    }
    expect(await count("trace", "ask_id = ?", id)).toBe(2);
  });

  it("holds at most 50 events per Ask", async () => {
    const svc = services();
    const { token, id } = await answered(svc);
    // `delivered` plus 49 reported events fill the trace.
    for (let i = 0; i < 49; i++) {
      const response = await trace(svc, token, id, {
        event: "progress",
        note: `step ${i}`,
      });
      expect(response.status, `event ${i + 2}`).toBe(200);
    }
    const full = await trace(svc, token, id, {
      event: "applied",
      url: EVIDENCE,
    });
    expect(full.status).toBe(409);
    expect((await errorOf(full)).message).toContain("full");
    expect(await count("trace", "ask_id = ?", id)).toBe(50);
  });

  it("validates reference keys and values", async () => {
    const svc = services();
    const { token, id } = await answered(svc);
    const tooMany = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]),
    );
    const sixteen = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"]),
    );
    for (const refs of [
      { "Orca.Run": "r_1" },
      { "1run": "r_1" },
      { run: "" },
      { run: "line\nbreak" },
      { [`k${"x".repeat(64)}`]: "v" },
      tooMany,
    ]) {
      const response = await trace(svc, token, id, { event: "progress", refs });
      expect(response.status, JSON.stringify(refs)).toBe(400);
    }
    expect(await count("trace", "ask_id = ?", id)).toBe(0);
    const ok = await trace(svc, token, id, {
      event: "progress",
      refs: sixteen,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json<Ask>()).trace.at(-1)?.refs).toEqual(sixteen);
  });

  it("accepts a 1 KiB note and refuses a longer one", async () => {
    const svc = services();
    const { token, id } = await answered(svc);
    const over = await trace(svc, token, id, {
      event: "progress",
      note: "x".repeat(1025),
    });
    expect(over.status).toBe(400);
    // Counted in UTF-8 bytes: 513 two-byte characters exceed 1 KiB.
    expect(
      (
        await trace(svc, token, id, {
          event: "progress",
          note: "é".repeat(513),
        })
      ).status,
    ).toBe(400);
    const exact = await trace(svc, token, id, {
      event: "progress",
      note: "x".repeat(1024),
    });
    expect(exact.status).toBe(200);
  });

  it("refuses Roger's own `delivered` and unknown fields", async () => {
    const svc = services();
    const { token, id } = await answered(svc);
    expect((await trace(svc, token, id, { event: "delivered" })).status).toBe(
      400,
    );
    expect(
      (await trace(svc, token, id, { event: "progress", extra: 1 })).status,
    ).toBe(400);
    expect(
      (
        await trace(svc, token, id, {
          event: "applied",
          url: "http://example.com",
        })
      ).status,
    ).toBe(400);
    expect(await count("trace", "ask_id = ?", id)).toBe(0);
  });
});
