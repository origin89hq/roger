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
