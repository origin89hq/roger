import { Accounts } from "./accounts.ts";
import { createApp, type Services } from "./app.ts";
import { readConfig } from "./config.ts";
import { runCron } from "./cron.ts";
import { githubApi } from "./github.ts";
import { failure } from "./http.ts";
import { ntfy } from "./notify.ts";
import { Passkeys } from "./passkeys.ts";
import { Store } from "./store.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      NTFY_TOKEN?: string;
    }
  }
}

function services(env: Env, ctx: ExecutionContext): Services | null {
  const config = readConfig(env);
  if (typeof config === "string") {
    console.error({ event: "config_invalid", problem: config });
    return null;
  }
  const accounts = new Accounts(env.DB);
  return {
    store: new Store(env.DB),
    accounts,
    passkeys: new Passkeys(accounts, config),
    github: githubApi(config.github.clientId, config.github.clientSecret),
    notifier: config.ntfy ? ntfy(config.ntfy.url, config.ntfy.token) : null,
    config,
    now: Date.now,
    defer: (work) => ctx.waitUntil(work),
  };
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const svc = services(env, ctx);
    if (!svc) return failure(500, "internal", "The service is not configured.");
    return createApp(svc).fetch(request);
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    const svc = services(env, ctx);
    if (svc) await runCron(svc);
  },
} satisfies ExportedHandler<Env>;
