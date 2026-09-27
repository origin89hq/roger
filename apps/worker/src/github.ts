import type { Responder } from "./store.ts";

/** The GitHub calls sign-in needs. The access token is used for these checks and then dropped. */
export interface GitHub {
  /** Exchanges an OAuth code for an access token, or `null` if GitHub refuses it. */
  exchange(code: string, redirectUri: string): Promise<string | null>;
  user(token: string): Promise<Responder | null>;
  /**
   * Whether `login` is an active member of the team. GitHub's 403 and 404
   * count as no; any other failure is `unavailable`, so a GitHub outage is not
   * reported as a refusal.
   */
  teamMembership(
    token: string,
    org: string,
    team: string,
    login: string,
  ): Promise<Membership>;
  /**
   * Who a token belongs to, only if this app issued it: a personal access
   * token or another app's token is `foreign`. Any other failure is
   * `unavailable`.
   */
  appUser(token: string): Promise<Responder | "foreign" | "unavailable">;
  /**
   * Revokes an access token this app issued, so one handed over by
   * `roger login` cannot be used again. `false` if GitHub did not confirm.
   */
  revoke(token: string): Promise<boolean>;
}

export type Membership = "active" | "none" | "unavailable";

const TIMEOUT_MS = 10_000;

export function githubApi(clientId: string, clientSecret: string): GitHub {
  const api = (token: string, path: string) =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "roger",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  // The app's own credentials, for the token endpoints under /applications.
  const appHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    "user-agent": "roger",
    "x-github-api-version": "2022-11-28",
  };
  return {
    async exchange(code, redirectUri) {
      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      if (!response.ok) return null;
      const body: unknown = await response.json();
      return typeof body === "object" &&
        body !== null &&
        "access_token" in body &&
        typeof body.access_token === "string"
        ? body.access_token
        : null;
    },
    async user(token) {
      const response = await api(token, "/user");
      if (!response.ok) return null;
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        Number.isSafeInteger(body.id) &&
        "login" in body &&
        typeof body.login === "string"
      )
        return { githubId: Number(body.id), login: body.login };
      return null;
    },
    async appUser(token) {
      let response: Response;
      try {
        response = await fetch(
          `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
          {
            method: "POST",
            headers: { ...appHeaders, "content-type": "application/json" },
            body: JSON.stringify({ access_token: token }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
      } catch {
        return "unavailable";
      }
      // GitHub answers 404 or 422 for a token this app did not issue.
      if (response.status === 404 || response.status === 422) return "foreign";
      if (!response.ok) return "unavailable";
      const body: unknown = await response.json();
      const user =
        typeof body === "object" && body !== null && "user" in body
          ? body.user
          : null;
      if (
        typeof user === "object" &&
        user !== null &&
        "id" in user &&
        Number.isSafeInteger(user.id) &&
        "login" in user &&
        typeof user.login === "string"
      )
        return { githubId: Number(user.id), login: user.login };
      return "unavailable";
    },
    async revoke(token) {
      try {
        const response = await fetch(
          `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
          {
            method: "DELETE",
            headers: { ...appHeaders, "content-type": "application/json" },
            body: JSON.stringify({ access_token: token }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
        return response.status === 204;
      } catch {
        return false;
      }
    },
    async teamMembership(token, org, team, login) {
      let response: Response;
      try {
        response = await api(
          token,
          `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`,
        );
      } catch {
        return "unavailable";
      }
      if (response.status === 403 || response.status === 404) return "none";
      if (!response.ok) return "unavailable";
      const body: unknown = await response.json();
      return typeof body === "object" &&
        body !== null &&
        "state" in body &&
        body.state === "active"
        ? "active"
        : "none";
    },
  };
}
