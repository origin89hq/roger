import { describe, expect, it } from "vitest";
import type { Ask, AskState } from "../src/protocol.gen.ts";
import {
  agent,
  answerAsk,
  approval,
  count,
  createAsk,
  errorOf,
  person,
  REV,
  requester,
  services,
  type TestServices,
} from "./helpers.ts";

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Checks that `winner` closed the Ask alone: one closing audit row and an answer only if answered. */
async function expectClosedOnceBy(id: string, winner: AskState) {
  expect(await count("asks", "id = ? AND state = ?", id, winner)).toBe(1);
  expect(await count("answers", "ask_id = ?", id)).toBe(
    winner === "answered" ? 1 : 0,
  );
  expect(await count("ask_events", "ask_id = ? AND state <> 'open'", id)).toBe(
    1,
  );
  expect(
    await count("ask_events", "ask_id = ? AND state = ?", id, winner),
  ).toBe(1);
}

async function setup() {
  const svc = services();
  const me = await person(svc);
  const bot = await requester(svc, me);
  return { svc, me, bot };
}

/**
 * Makes `method` wait until `gate` resolves before it writes, so the other
 * request commits between this one's checks and its conditional write.
 */
function holdBeforeWrite(
  svc: TestServices,
  method: "answer" | "withdraw",
  gate: Promise<unknown>,
) {
  const original = svc.store[method].bind(svc.store) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let reached: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  Object.assign(svc.store, {
    [method]: async (...args: unknown[]) => {
      reached();
      await gate;
      return original(...args);
    },
  });
  return arrived;
}

describe("concurrent transitions", () => {
  it("lets exactly one of an answer and a withdrawal win", async () => {
    const { svc, me, bot } = await setup();
    for (let round = 0; round < 16; round++) {
      const ask = await createAsk(svc, bot.token);
      // Which side wins depends on scheduling; odd rounds give the answer a head start.
      const withdraw = () =>
        agent(svc, bot.token, "POST", `/v1/asks/${ask.id}/withdraw`);
      const [answered, withdrawn] = await Promise.all([
        answerAsk(svc, me.cookie, ask.id, { option: "reject", rev: REV }),
        round % 2 === 0 ? withdraw() : delay(0).then(withdraw),
      ]);
      expect([answered.status, withdrawn.status].sort()).toEqual([200, 409]);
      const [won, lost] =
        answered.status === 200 ? [answered, withdrawn] : [withdrawn, answered];
      const winner = (await won.json<Ask>()).state;
      expect(winner).toBe(answered.status === 200 ? "answered" : "withdrawn");
      expect((await errorOf(lost)).state).toBe(winner);
      await expectClosedOnceBy(ask.id, winner);
    }
  });

  it("fails an answer whose Ask is withdrawn after the answer's checks passed", async () => {
    const { svc, me, bot } = await setup();
    const ask = await createAsk(svc, bot.token);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = holdBeforeWrite(svc, "answer", gate);
    const answering = answerAsk(svc, me.cookie, ask.id, {
      option: "reject",
      rev: REV,
    });
    await arrived;
    const withdrawn = await agent(
      svc,
      bot.token,
      "POST",
      `/v1/asks/${ask.id}/withdraw`,
    );
    release();
    const answered = await answering;
    expect(withdrawn.status).toBe(200);
    expect(answered.status).toBe(409);
    expect((await errorOf(answered)).state).toBe("withdrawn");
    await expectClosedOnceBy(ask.id, "withdrawn");
  });

  it("fails a withdrawal whose Ask is answered after the withdrawal read it", async () => {
    const { svc, me, bot } = await setup();
    const ask = await createAsk(svc, bot.token);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrived = holdBeforeWrite(svc, "withdraw", gate);
    const withdrawing = agent(
      svc,
      bot.token,
      "POST",
      `/v1/asks/${ask.id}/withdraw`,
    );
    await arrived;
    const answered = await answerAsk(svc, me.cookie, ask.id, {
      option: "reject",
      rev: REV,
    });
    release();
    const withdrawn = await withdrawing;
    expect(answered.status).toBe(200);
    expect(withdrawn.status).toBe(409);
    expect((await errorOf(withdrawn)).state).toBe("answered");
    await expectClosedOnceBy(ask.id, "answered");
  });

  it("fails a supersession whose Ask is answered first, and creates no replacement", async () => {
    const { svc, me, bot } = await setup();
    for (let round = 0; round < 8; round++) {
      const ask = await createAsk(svc, bot.token);
      const replacement = approval({
        decisionKey: ask.decisionKey,
        supersedes: ask.id,
      });
      const [answered, superseding] = await Promise.all([
        answerAsk(svc, me.cookie, ask.id, { option: "reject", rev: REV }),
        delay(round).then(() =>
          agent(svc, bot.token, "POST", "/v1/asks", replacement),
        ),
      ]);
      const answerWon = answered.status === 200;
      expect([answered.status, superseding.status]).toEqual(
        answerWon ? [200, 409] : [409, 201],
      );
      await expectClosedOnceBy(ask.id, answerWon ? "answered" : "superseded");
      expect(await count("asks", "idem_key = ?", replacement.idemKey)).toBe(
        answerWon ? 0 : 1,
      );
    }
  });
});
