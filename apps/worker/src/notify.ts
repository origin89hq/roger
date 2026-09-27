import type { Ask } from "./protocol.gen.ts";
import type { PushJob } from "./store.ts";

/** A push. Never carries an Ask's body, links, or action. */
export interface Push {
  title: string;
  message: string;
  /** ntfy priority, 1 (min) to 5 (urgent). */
  priority: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  click: string;
}

export interface Notifier {
  /** Throws if the push was not accepted. */
  send(topic: string, push: Push): Promise<void>;
}

export function ntfy(url: string, token: string | null): Notifier {
  return {
    async send(topic, push) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ topic, ...push }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
    },
  };
}

const PRIORITY: Record<Ask["urgency"], Push["priority"]> = {
  now: 5,
  soon: 4,
  later: 3,
  fyi: 2,
};

export function askPush(job: PushJob, origin: string): Push {
  const source = job.repo ? `${job.requester} · ${job.repo}` : job.requester;
  return {
    title: job.title,
    message: `${job.urgency} · ${job.risk} · ${source}`,
    priority: PRIORITY[job.urgency],
    tags: job.risk === "routine" ? [] : ["warning"],
    click: `${origin}/#ask=${job.askId}`,
  };
}

export function digestPush(open: readonly Ask[], origin: string): Push {
  const byRequester = new Map<string, number>();
  for (const ask of open)
    byRequester.set(ask.requester, (byRequester.get(ask.requester) ?? 0) + 1);
  const sources = [...byRequester]
    .map(([name, n]) => `${name} (${n})`)
    .join(", ");
  const titles = open.slice(0, 10).map((a) => `• ${a.title}`);
  if (open.length > titles.length)
    titles.push(`• and ${open.length - titles.length} more`);
  return {
    title: `${open.length} open ${open.length === 1 ? "Ask" : "Asks"}`,
    message: [sources, ...titles].join("\n"),
    priority: 3,
    tags: [],
    click: `${origin}/`,
  };
}

export function machineLoginPush(
  login: string,
  machine: string,
  source: string,
  origin: string,
): Push {
  return {
    title: "A machine logged in to your Roger account",
    message: `${login} logged in machine ${machine} from ${source}. It can create Asks and read answers as its requesters. If this was not you, revoke it in Settings.`,
    priority: 4,
    tags: ["warning"],
    click: `${origin}/#settings`,
  };
}

export function passkeyAddedPush(login: string, origin: string): Push {
  return {
    title: "A passkey was added to your Roger account",
    message: `${login} registered a new passkey, which can approve Asks. If this was not you, have it removed from the passkeys table and sign out.`,
    priority: 4,
    tags: ["warning"],
    click: `${origin}/#settings`,
  };
}
