import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/ids.ts";
import { MACHINE_REQUESTER_LIMIT } from "../src/machines.ts";
import type {
  Ask,
  AskList,
  DeviceAuthorization,
  DeviceErrorBody,
  MachineToken,
} from "../src/protocol.gen.ts";
import {
  agent,
  approval,
  browser,
  count,
  createAsk,
  errorOf,
  minutes,
  ORIGIN,
  person,
  question,
  requester,
  send,
  services,
  type TestServices,
} from "./helpers.ts";

const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

function form(
  svc: TestServices,
  path: string,
  fields: Record<string, string>,
): Promise<Response> {
  return send(
    svc,
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

async function start(
  svc: TestServices,
  machine: string | null = "studio",
): Promise<DeviceAuthorization> {
  const fields: Record<string, string> = { client_id: "roger-cli" };
  if (machine) fields.machine = machine;
  const response = await form(svc, "/v1/device/code", fields);
  expect(response.status).toBe(200);
  return response.json<DeviceAuthorization>();
}

function poll(svc: TestServices, deviceCode: string): Promise<Response> {
  return form(svc, "/v1/device/token", {
    client_id: "roger-cli",
    grant_type: GRANT,
    device_code: deviceCode,
  });
}

async function pollError(svc: TestServices, deviceCode: string) {
  const response = await poll(svc, deviceCode);
  expect(response.status).toBe(400);
  return (await response.json<DeviceErrorBody>()).error;
}

/** A machine name no other test uses. */
function machineName(): string {
  return `m-${crypto.randomUUID().slice(0, 8)}`;
}

/** Logs a machine in for `owner` and returns its credential. */
async function login(
  svc: TestServices,
  owner: { cookie: string },
  name = machineName(),
) {
  const started = await start(svc, null);
  const approved = await browser(
    svc,
    owner.cookie,
    "POST",
    "/v1/inbox/device/approve",
    { userCode: started.user_code, machine: name },
  );
  expect(approved.status).toBe(204);
  const response = await poll(svc, started.device_code);
  expect(response.status).toBe(200);
  const token = await response.json<MachineToken>();
  return { name, credential: token.access_token };
}

/** Calls the agent API with a machine credential acting as `as`. */
function as(
  svc: TestServices,
  credential: string,
  name: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return agent(
    svc,
    credential,
    method,
    path,
    body,
    name === null ? {} : { "roger-requester": name },
  );
}

describe("device authorization", () => {
  it("issues a machine credential once the person approves, stored only as a hash", async () => {
    const svc = services();
    const me = await person(svc);
    const started = await start(svc, "studio");
    expect(started.user_code).toMatch(
      /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
    );
    expect(started.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started).toMatchObject({
      verification_uri: `${ORIGIN}/#device`,
      verification_uri_complete: `${ORIGIN}/#device=${started.user_code}`,
      expires_in: 900,
      interval: 5,
    });

    // The inbox finds the login by its code, typed loosely.
    const typed = started.user_code.replace("-", "").toLowerCase();
    const lookup = await browser(svc, me.cookie, "POST", "/v1/inbox/device", {
      userCode: typed,
    });
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ suggested: "studio" });

    expect(await pollError(svc, started.device_code)).toBe(
      "authorization_pending",
    );
    const name = machineName();
    const approved = await browser(
      svc,
      me.cookie,
      "POST",
      "/v1/inbox/device/approve",
      {
        userCode: typed,
        machine: name,
      },
    );
    expect(approved.status).toBe(204);

    svc.clock.now += 5_000;
    const response = await poll(svc, started.device_code);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const token = await response.json<MachineToken>();
    expect(token).toMatchObject({
      token_type: "Bearer",
      machine: name,
      owner: me.login,
    });
    expect(token.access_token).toMatch(/^rogm_[A-Za-z0-9_-]{43}$/);
    expect(
      await count(
        "machines",
        "hash = ? AND owner = ?",
        await sha256(token.access_token),
        me.githubId,
      ),
    ).toBe(1);
    expect(await count("machines", "hash = ?", token.access_token)).toBe(0);

    // The device code works once.
    svc.clock.now += 5_000;
    expect(await pollError(svc, started.device_code)).toBe("invalid_grant");
    expect(await count("machines", "owner = ?", me.githubId)).toBe(1);
  });

  it("tells a client that polls too fast to slow down, and grows its interval", async () => {
    const svc = services();
    const started = await start(svc);
    expect(await pollError(svc, started.device_code)).toBe(
      "authorization_pending",
    );
    svc.clock.now += 1_000;
    expect(await pollError(svc, started.device_code)).toBe("slow_down");
    // The interval is now 10 s from the last poll.
    svc.clock.now += 6_000;
    expect(await pollError(svc, started.device_code)).toBe("slow_down");
    svc.clock.now += 15_000;
    expect(await pollError(svc, started.device_code)).toBe(
      "authorization_pending",
    );
  });

  it("refuses the login once the person denies it", async () => {
    const svc = services();
    const me = await person(svc);
    const started = await start(svc);
    const denied = await browser(
      svc,
      me.cookie,
      "POST",
      "/v1/inbox/device/deny",
      {
        userCode: started.user_code,
      },
    );
    expect(denied.status).toBe(204);
    expect(await pollError(svc, started.device_code)).toBe("access_denied");
    const late = await browser(
      svc,
      me.cookie,
      "POST",
      "/v1/inbox/device/approve",
      {
        userCode: started.user_code,
        machine: machineName(),
      },
    );
    expect(late.status).toBe(404);
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
  });

  it("expires an unapproved login after 15 minutes", async () => {
    const svc = services();
    const me = await person(svc);
    const started = await start(svc);
    svc.clock.now += minutes(15);
    expect(await pollError(svc, started.device_code)).toBe("expired_token");
    const late = await browser(
      svc,
      me.cookie,
      "POST",
      "/v1/inbox/device/approve",
      {
        userCode: started.user_code,
        machine: machineName(),
      },
    );
    expect(late.status).toBe(404);
    const lookup = await browser(svc, me.cookie, "POST", "/v1/inbox/device", {
      userCode: started.user_code,
    });
    expect(lookup.status).toBe(404);
  });

  it("does not issue a credential for a login approved just before it expired", async () => {
    const svc = services();
    const me = await person(svc);
    const started = await start(svc);
    svc.clock.now += minutes(15) - 1;
    const approved = await browser(
      svc,
      me.cookie,
      "POST",
      "/v1/inbox/device/approve",
      {
        userCode: started.user_code,
        machine: machineName(),
      },
    );
    expect(approved.status).toBe(204);
    svc.clock.now += 1;
    expect(await pollError(svc, started.device_code)).toBe("expired_token");
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
  });

  it("rejects malformed device requests", async () => {
    const svc = services();
    const wrongClient = await form(svc, "/v1/device/code", {
      client_id: "other",
    });
    expect(wrongClient.status).toBe(401);
    expect((await wrongClient.json<DeviceErrorBody>()).error).toBe(
      "invalid_client",
    );
    const badName = await form(svc, "/v1/device/code", {
      client_id: "roger-cli",
      machine: "Studio/../x",
    });
    expect((await badName.json<DeviceErrorBody>()).error).toBe(
      "invalid_request",
    );
    const asJson = await agent(svc, null, "POST", "/v1/device/code", {
      client_id: "roger-cli",
    });
    expect((await asJson.json<DeviceErrorBody>()).error).toBe(
      "invalid_request",
    );

    const started = await start(svc);
    const wrongGrant = await form(svc, "/v1/device/token", {
      client_id: "roger-cli",
      grant_type: "authorization_code",
      device_code: started.device_code,
    });
    expect((await wrongGrant.json<DeviceErrorBody>()).error).toBe(
      "unsupported_grant_type",
    );
    expect(await pollError(svc, "not-a-device-code")).toBe("invalid_grant");
  });

  it("needs a signed-in person to approve, deny, or look up a code", async () => {
    const svc = services();
    const started = await start(svc);
    for (const path of [
      "/v1/inbox/device",
      "/v1/inbox/device/approve",
      "/v1/inbox/device/deny",
    ]) {
      const response = await browser(svc, null, "POST", path, {
        userCode: started.user_code,
        machine: machineName(),
      });
      expect(response.status, path).toBe(401);
    }
    expect(await pollError(svc, started.device_code)).toBe(
      "authorization_pending",
    );
  });

  it("keeps each machine name to one person, and a new login replaces the owner's old one", async () => {
    const svc = services();
    const me = await person(svc);
    const other = await person(svc);
    const studio = await login(svc, me);
    const created = await createAsk(svc, studio.credential, question());

    const approve = (cookie: string, userCode: string, machine: string) =>
      browser(svc, cookie, "POST", "/v1/inbox/device/approve", {
        userCode,
        machine,
      });
    const theirs = await approve(
      other.cookie,
      (await start(svc)).user_code,
      studio.name,
    );
    expect(theirs.status).toBe(409);
    expect((await errorOf(theirs)).message).toContain("Someone else");

    // Until the new login is collected, the old one keeps working.
    const again = await start(svc);
    expect(
      (await approve(me.cookie, again.user_code, studio.name)).status,
    ).toBe(204);
    expect(
      (await agent(svc, studio.credential, "GET", "/v1/asks")).status,
    ).toBe(200);
    const token = await (
      await poll(svc, again.device_code)
    ).json<MachineToken>();
    expect(
      (await agent(svc, studio.credential, "GET", "/v1/asks")).status,
    ).toBe(401);
    const read = await agent(
      svc,
      token.access_token,
      "GET",
      `/v1/asks/${created.id}`,
    );
    expect(read.status).toBe(200);
    expect(
      await count("machines", "owner = ? AND revoked_at IS NULL", me.githubId),
    ).toBe(1);
  });

  it("refuses to issue a name another person's machine took after approval", async () => {
    const svc = services();
    const me = await person(svc);
    const other = await person(svc);
    const name = machineName();
    const mine = await start(svc);
    const theirs = await start(svc);
    const approve = (cookie: string, userCode: string) =>
      browser(svc, cookie, "POST", "/v1/inbox/device/approve", {
        userCode,
        machine: name,
      });
    expect((await approve(me.cookie, mine.user_code)).status).toBe(204);
    // The other approval sees mine pending and is refused.
    expect((await approve(other.cookie, theirs.user_code)).status).toBe(409);
    // Had both passed the check, the index refuses the second credential.
    await env.DB.prepare(
      "INSERT INTO machines (id, name, owner, hash, created_at) VALUES (?, ?, ?, ?, 0)",
    )
      .bind(crypto.randomUUID(), name, other.githubId, crypto.randomUUID())
      .run();
    expect(await pollError(svc, mine.device_code)).toBe("invalid_grant");
    expect(await count("machines", "owner = ?", me.githubId)).toBe(0);
  });

  it("sweeps expired logins", async () => {
    const svc = services();
    const started = await start(svc);
    const hash = await sha256(started.device_code);
    svc.clock.now += minutes(16);
    await svc.machines.sweep(svc.now(), 200);
    expect(await count("device_codes", "device_hash = ?", hash)).toBe(0);
  });
});

describe("machine credentials", () => {
  it("act as <machine>/default without a name, and <machine>/<name> with one", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const plain = await as(
      svc,
      studio.credential,
      null,
      "POST",
      "/v1/asks",
      question(),
    );
    expect(plain.status).toBe(201);
    expect((await plain.json<Ask>()).requester).toBe(`${studio.name}/default`);
    const named = await as(
      svc,
      studio.credential,
      "merge-gate",
      "POST",
      "/v1/asks",
      approval(),
    );
    expect(named.status).toBe(201);
    const ask = await named.json<Ask>();
    expect(ask.requester).toBe(`${studio.name}/merge-gate`);
    // Asks go to the machine's owner by default.
    expect(ask.to).toBe(me.login);
  });

  it("keep two automations on one machine apart", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const shared = question({
      idemKey: "same-idem",
      decisionKey: "same-decision",
    });
    const a = await as(
      svc,
      studio.credential,
      "coordinator",
      "POST",
      "/v1/asks",
      shared,
    );
    const b = await as(
      svc,
      studio.credential,
      "merge-gate",
      "POST",
      "/v1/asks",
      shared,
    );
    // Idempotency keys and the one-open-Ask-per-decision rule are per requester.
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const askA = await a.json<Ask>();
    const askB = await b.json<Ask>();
    expect(askA.id).not.toBe(askB.id);

    const listA = await (
      await as(svc, studio.credential, "coordinator", "GET", "/v1/asks")
    ).json<AskList>();
    expect(listA.asks.map((x) => x.id)).toEqual([askA.id]);
    for (const [method, path, body] of [
      ["GET", `/v1/asks/${askA.id}`, undefined],
      ["POST", `/v1/asks/${askA.id}/withdraw`, {}],
      ["POST", `/v1/asks/${askA.id}/trace`, { event: "progress" }],
    ] as const) {
      const response = await as(
        svc,
        studio.credential,
        "merge-gate",
        method,
        path,
        body,
      );
      expect(response.status, path).toBe(404);
    }
    const events = await (
      await as(svc, studio.credential, "merge-gate", "GET", "/v1/events")
    ).json<{
      events: { askId: string }[];
    }>();
    expect(events.events.map((e) => e.askId)).toEqual([askB.id]);
  });

  it("are refused once the machine is revoked in Settings or logs out", async () => {
    const svc = services();
    const me = await person(svc);
    const inSettings = await login(svc, me);
    const { machines } = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/machines")
    ).json<{
      machines: { id: string; name: string }[];
    }>();
    const id = machines.find((m) => m.name === inSettings.name)?.id;
    expect(
      (await browser(svc, me.cookie, "POST", `/v1/inbox/machines/${id}/revoke`))
        .status,
    ).toBe(204);
    const refused = await as(
      svc,
      inSettings.credential,
      "x",
      "GET",
      "/v1/asks",
    );
    expect(refused.status).toBe(401);

    const loggedOut = await login(svc, me);
    expect(
      (await agent(svc, loggedOut.credential, "POST", "/v1/machine/logout"))
        .status,
    ).toBe(204);
    expect(
      (await agent(svc, loggedOut.credential, "GET", "/v1/asks")).status,
    ).toBe(401);
    expect(
      (await agent(svc, loggedOut.credential, "POST", "/v1/machine/logout"))
        .status,
    ).toBe(401);
  });

  it("stop one automation when its requester is disabled, leaving the others", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const first = await createAsk(svc, studio.credential, question());
    const byName = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/machines")
    ).json<{
      machines: { name: string; requesters: { id: string; name: string }[] }[];
    }>();
    const defaultRequester = byName.machines
      .find((m) => m.name === studio.name)
      ?.requesters.find((r) => r.name === `${studio.name}/default`);
    expect(first.requester).toBe(defaultRequester?.name);
    const disabled = await browser(
      svc,
      me.cookie,
      "POST",
      `/v1/inbox/requesters/${defaultRequester?.id}/disable`,
    );
    expect(disabled.status).toBe(204);
    const refused = await as(svc, studio.credential, null, "GET", "/v1/asks");
    expect(refused.status).toBe(403);
    expect(
      (await as(svc, studio.credential, "other", "GET", "/v1/asks")).status,
    ).toBe(200);
  });

  it("reject an invalid automation name", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    for (const name of ["Upper", "a/b", "", "-lead"]) {
      const response = await as(
        svc,
        studio.credential,
        name,
        "GET",
        "/v1/asks",
      );
      expect(response.status, name).toBe(400);
    }
  });

  it("create at most a bounded number of requesters per machine", async () => {
    const svc = services();
    const me = await person(svc);
    const studio = await login(svc, me);
    const inserts = Array.from({ length: MACHINE_REQUESTER_LIMIT }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO requesters (id, name, pickup_minutes, completion_minutes, created_by, created_at, machine)
         VALUES (?, ?, 1, 1, ?, 0, ?)`,
      ).bind(
        `${studio.name}-${i}`,
        `${studio.name}/job-${i}`,
        me.githubId,
        studio.name,
      ),
    );
    await env.DB.batch(inserts);
    expect(
      (await as(svc, studio.credential, "job-1", "GET", "/v1/asks")).status,
    ).toBe(200);
    const full = await as(
      svc,
      studio.credential,
      "one-more",
      "GET",
      "/v1/asks",
    );
    expect(full.status).toBe(403);
  });

  it("can adopt a requester the owner made in Settings, whose token keeps working", async () => {
    const svc = services();
    const me = await person(svc);
    const other = await person(svc);
    const legacy = await requester(svc, me);
    const theirs = await requester(svc, other);
    const studio = await login(svc, me);
    const before = await createAsk(svc, legacy.token, question());

    const adopt = (name: string) =>
      agent(svc, studio.credential, "POST", "/v1/machine/adopt", { name });
    expect((await adopt(theirs.name)).status).toBe(404);
    expect((await adopt(legacy.name)).status).toBe(200);
    // Adoption is once: another machine cannot take it.
    const laptop = await login(svc, me);
    expect(
      (
        await agent(svc, laptop.credential, "POST", "/v1/machine/adopt", {
          name: legacy.name,
        })
      ).status,
    ).toBe(404);

    const read = await as(
      svc,
      studio.credential,
      legacy.name,
      "GET",
      `/v1/asks/${before.id}`,
    );
    expect(read.status).toBe(200);
    const created = await as(
      svc,
      studio.credential,
      legacy.name,
      "POST",
      "/v1/asks",
      question(),
    );
    expect((await created.json<Ask>()).requester).toBe(legacy.name);
    expect((await agent(svc, legacy.token, "GET", "/v1/asks")).status).toBe(
      200,
    );
    // Another machine naming it gets its own requester, not the adopted one.
    const elsewhere = await as(
      svc,
      laptop.credential,
      legacy.name,
      "POST",
      "/v1/asks",
      question(),
    );
    expect((await elsewhere.json<Ask>()).requester).toBe(
      `${laptop.name}/${legacy.name}`,
    );
    // A static token cannot manage a machine.
    expect(
      (
        await agent(svc, legacy.token, "POST", "/v1/machine/adopt", {
          name: legacy.name,
        })
      ).status,
    ).toBe(401);
  });

  it("are listed in Settings only for their owner", async () => {
    const svc = services();
    const me = await person(svc);
    const other = await person(svc);
    const studio = await login(svc, me);
    await createAsk(svc, studio.credential, question());
    const mine = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/machines")
    ).json<{
      machines: { id: string; name: string; requesters: { name: string }[] }[];
    }>();
    const listed = mine.machines.find((m) => m.name === studio.name);
    expect(listed?.requesters.map((r) => r.name)).toEqual([
      `${studio.name}/default`,
    ]);
    const theirs = await (
      await browser(svc, other.cookie, "GET", "/v1/inbox/machines")
    ).json<{
      machines: unknown[];
    }>();
    expect(theirs.machines).toEqual([]);
    const stolen = await browser(
      svc,
      other.cookie,
      "POST",
      `/v1/inbox/machines/${listed?.id}/revoke`,
    );
    expect(stolen.status).toBe(404);
    // Machine requesters stay out of the hand-made requester list.
    const requesters = await (
      await browser(svc, me.cookie, "GET", "/v1/inbox/requesters")
    ).json<{
      requesters: { name: string }[];
    }>();
    expect(requesters.requesters).toEqual([]);
  });
});

describe("static tokens", () => {
  it("are still accepted, and cannot name another requester", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    const created = await agent(svc, bot.token, "POST", "/v1/asks", question());
    expect(created.status).toBe(201);
    expect((await created.json<Ask>()).requester).toBe(bot.name);
    const named = await agent(svc, bot.token, "GET", "/v1/asks", undefined, {
      "roger-requester": "other",
    });
    expect(named.status).toBe(400);
  });
});
