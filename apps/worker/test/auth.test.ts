import { describe, expect, it } from "vitest";
import {
  agent,
  approval,
  browser,
  count,
  createAsk,
  newPerson,
  ORIGIN,
  person,
  requester,
  send,
  services,
  type TestServices,
} from "./helpers.ts";

function callback(
  svc: TestServices,
  query: string,
  oauthCookie: string | null,
) {
  const headers = new Headers();
  if (oauthCookie) headers.set("cookie", `__Host-roger-oauth=${oauthCookie}`);
  return send(
    svc,
    new Request(`${ORIGIN}/auth/callback?${query}`, { headers }),
  );
}

/** The value of cookie `name` from a response, with its attributes. */
function setCookie(
  response: Response,
  name: string,
): { value: string; attributes: string[] } | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split(";").map((p) => p.trim());
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq) === name)
      return { value: pair.slice(eq + 1), attributes };
  }
  return null;
}

/** A GitHub user that the fake accepts, with `code` as both OAuth code and token. */
function githubUser(svc: TestServices, member: boolean) {
  const who = newPerson();
  const code = `code-${who.githubId}`;
  svc.github.users.set(code, who);
  if (member) svc.github.members.add(who.login);
  return { ...who, code };
}

describe("sign-in", () => {
  it("redirects to GitHub with a state bound to a Lax cookie", async () => {
    const svc = services();
    const response = await send(svc, new Request(`${ORIGIN}/auth/login`));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/auth/callback`,
    );
    expect(location.searchParams.get("scope")).toBe("read:org");
    const state = location.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = setCookie(response, "__Host-roger-oauth");
    expect(cookie?.value).toBe(state);
    expect(cookie?.attributes).toEqual(
      expect.arrayContaining([
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Max-Age=600",
      ]),
    );
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const svc = services();
    const user = githubUser(svc, true);
    for (const [query, cookie] of [
      [`code=${user.code}&state=other`, "expected"],
      [`code=${user.code}&state=expected`, null],
      [`code=${user.code}`, "expected"],
      ["state=expected", "expected"],
    ] as const) {
      const response = await callback(svc, query, cookie);
      expect(response.status, `${query} / ${cookie}`).toBe(400);
      expect(setCookie(response, "__Host-roger")).toBeNull();
    }
    expect(await count("responders", "github_id = ?", user.githubId)).toBe(0);
  });

  it("refuses a code GitHub does not accept", async () => {
    const svc = services();
    const response = await callback(svc, "code=bogus&state=s", "s");
    expect(response.status).toBe(403);
    expect(setCookie(response, "__Host-roger")).toBeNull();
  });

  it("refuses a person outside the team and creates no session", async () => {
    const svc = services();
    const user = githubUser(svc, false);
    const response = await callback(svc, `code=${user.code}&state=s`, "s");
    expect(response.status).toBe(403);
    expect(setCookie(response, "__Host-roger")).toBeNull();
    expect(await count("responders", "github_id = ?", user.githubId)).toBe(0);
    expect(await count("sessions", "github_id = ?", user.githubId)).toBe(0);
  });

  it("asks to retry when GitHub cannot confirm membership, and creates no session", async () => {
    const svc = services();
    const user = githubUser(svc, true);
    svc.github.outage = true;
    const response = await callback(svc, `code=${user.code}&state=s`, "s");
    expect(response.status).toBe(503);
    expect(setCookie(response, "__Host-roger")).toBeNull();
    expect(await count("sessions", "github_id = ?", user.githubId)).toBe(0);
  });

  it("signs in a team member with a strict session cookie", async () => {
    const svc = services();
    const user = githubUser(svc, true);
    const response = await callback(svc, `code=${user.code}&state=s`, "s");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const session = setCookie(response, "__Host-roger");
    expect(session?.attributes).toEqual(
      expect.arrayContaining([
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Max-Age=28800",
      ]),
    );
    // The one-time OAuth cookie is cleared.
    expect(setCookie(response, "__Host-roger-oauth")?.attributes).toContain(
      "Max-Age=0",
    );
    expect(
      await count(
        "responders",
        "github_id = ? AND login = ?",
        user.githubId,
        user.login,
      ),
    ).toBe(1);

    const me = await browser(svc, session?.value ?? "", "GET", "/v1/inbox/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      login: user.login,
      githubId: user.githubId,
      passkeys: [],
    });
  });

  it("gives a reused login to its new owner and frees it from the old one", async () => {
    const svc = services();
    const old = await person(svc);
    const bot = await requester(svc, old);
    // GitHub user `old` renamed; a different account took the login.
    const successor = { githubId: old.githubId + 1, login: old.login };
    const code = `code-${successor.githubId}`;
    svc.github.users.set(code, successor);
    svc.github.members.add(successor.login);
    expect((await callback(svc, `code=${code}&state=s`, "s")).status).toBe(302);

    expect(
      await count(
        "responders",
        "github_id = ? AND login = ?",
        successor.githubId,
        old.login,
      ),
    ).toBe(1);
    expect(
      await count(
        "responders",
        "github_id = ? AND login = ?",
        old.githubId,
        old.login,
      ),
    ).toBe(0);
    const routed = await createAsk(svc, bot.token, approval({ to: old.login }));
    expect(routed.to).toBe(old.login);
    const addressed = await (
      await browser(svc, old.cookie, "GET", "/v1/inbox")
    ).json<{ open: unknown[] }>();
    expect(addressed.open).toEqual([]);

    // The old account signs in under its new name and keeps its id.
    const renamed = { githubId: old.githubId, login: `${old.login}-renamed` };
    svc.github.users.set("renamed", renamed);
    svc.github.members.add(renamed.login);
    expect((await callback(svc, "code=renamed&state=s", "s")).status).toBe(302);
    expect(
      await count(
        "responders",
        "github_id = ? AND login = ?",
        old.githubId,
        renamed.login,
      ),
    ).toBe(1);
    // Asks default to the owner by id, whatever the login.
    expect((await createAsk(svc, bot.token)).to).toBe(renamed.login);
  });
});

describe("sign-out", () => {
  it("ends the session for a same-origin request", async () => {
    const svc = services();
    const me = await person(svc);
    const response = await browser(svc, me.cookie, "POST", "/auth/logout");
    expect(response.status).toBe(204);
    expect(setCookie(response, "__Host-roger")?.attributes).toContain(
      "Max-Age=0",
    );
    expect(await svc.accounts.session(me.cookie, svc.now())).toBeNull();
    expect((await browser(svc, me.cookie, "GET", "/v1/inbox")).status).toBe(
      401,
    );
  });

  it("refuses a cross-origin sign-out and keeps the session", async () => {
    const svc = services();
    const me = await person(svc);
    const response = await send(
      svc,
      new Request(`${ORIGIN}/auth/logout`, {
        method: "POST",
        headers: {
          cookie: `__Host-roger=${me.cookie}`,
          origin: "https://evil.test",
        },
      }),
    );
    expect(response.status).toBe(403);
    expect((await browser(svc, me.cookie, "GET", "/v1/inbox")).status).toBe(
      200,
    );
  });

  it("keeps agent tokens working after the owner signs out", async () => {
    const svc = services();
    const me = await person(svc);
    const bot = await requester(svc, me);
    await browser(svc, me.cookie, "POST", "/auth/logout");
    expect((await agent(svc, bot.token, "GET", "/v1/asks")).status).toBe(200);
  });
});
