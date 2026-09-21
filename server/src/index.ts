// Webhook server — GitHub App webhook endpoint + health + analytics.
// Port of the Python run_server.py mounting pr_agent's router: we handle the
// pull_request webhook ourselves, verify HMAC, and dispatch to runReview.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config";
import { loadConfig } from "./config";
import { runReview } from "./review";

export interface WebhookEnv {
  cfg: Config;
  privateKeyPem: string;
  webhookSecret: string;
  analyticsDir: string;
  discordWebhookUrl: string;
  discordAlertWebhookUrl: string;
}

export async function handleWebhook(
  env: WebhookEnv,
  body: string,
  signatureHeader: string | null,
  event: string,
): Promise<{ status: number; body: unknown }> {
  // HMAC verification (sha256)
  if (!signatureHeader) {
    return { status: 403, body: { error: "missing signature" } };
  }
  const sig = signatureHeader.replace(/^sha256=/i, "");
  const expected = createHmac("sha256", env.webhookSecret).update(body).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  if (event !== "pull_request") {
    return { status: 200, body: { ok: true, ignored: true } };
  }

  let payload: {
    action?: string;
    pull_request?: {
      number?: number;
      state?: string;
      url?: string;
      draft?: boolean;
      labels?: { name?: string }[];
    };
    installation?: { id?: number };
  };
  try {
    payload = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: "invalid JSON" } };
  }

  const pr = payload.pull_request;
  if (!pr || !pr.number || pr.state !== "open" || pr.draft) {
    return { status: 200, body: { ok: true, ignored: true } };
  }

  // extract owner/repo from the pull_request.url (api.github.com/repos/{o}/{r}/pulls/{n})
  let owner = "";
  let repo = "";
  if (pr.url) {
    const m = /\/repos\/([^/]+)\/([^/]+)\/pulls\//.exec(pr.url);
    if (m) {
      owner = m[1];
      repo = m[2];
    }
  }
  if (!owner || !repo) {
    return { status: 200, body: { ok: true, ignored: true, error: "no repo" } };
  }

  // Fire and forget: dispatch review; respond fast (GitHub expects < 10s)
    void runReview(env.cfg, owner, repo, pr.number, env.privateKeyPem)
      .then(async (result) => {
        console.log(`[webhook] review done for ${owner}/${repo}#${pr.number}: ${result.status}, model ${result.model}, md ${result.markdown.length} chars`);
        logReviewEvent(env.analyticsDir, {
          message: result.status === "success" ? "Generated code suggestions" : `Failed to generate ${result.status}`,
          extra: {
            command: "review",
            pr_url: `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}`,
            model: result.model,
            model_request: result.model,
            pr_url_short: `${owner}/${repo}#${pr.number}`,
            error: result.status === "success" ? "" : result.status,
          },
        });
        if (env.analyticsDir) {
          try {
            const fsMod = await import("node:fs");
            fsMod.appendFileSync(
            `${env.analyticsDir}/pr-agent.bun.jsonl`,
            JSON.stringify({
              time: new Date().toISOString(),
              repo: `${owner}/${repo}`,
              pr: pr.number,
              command: "review",
              model: result.model,
              prompt_tokens: result.promptTokens,
              completion_tokens: result.completionTokens,
              cached_tokens: result.cachedTokens,
              markdown_len: result.markdown.length,
            }) + "\n",
          );
        } catch {
          // ignore
        }
      }
      if (result.markdown && env.discordWebhookUrl) {
        void sendDiscord(
          env.discordWebhookUrl,
          `**${owner}/${repo}** PR #${pr.number} reviewed` +
            (result.data && result.data["review"] && (result.data["review"] as Record<string, unknown>)["score"]
              ? ` — score ${(result.data["review"] as Record<string, unknown>)["score"]}/100`
              : "") +
            `\n${result.markdown.slice(0, 4000)}`,
          "✅ PR-Agent Review Complete",
        );
      }
    })
    .catch((e) => {
      console.error(`[webhook] review FAILED for ${owner}/${repo}#${pr.number}:`, e instanceof Error ? e.stack ?? e.message : e);
      if (env.discordAlertWebhookUrl) {
        void sendDiscord(
          env.discordAlertWebhookUrl,
          `**${owner}/${repo}** PR #${pr.number} review FAILED\n\`\`\`${String((e as Error).message)}\`\`\``,
          "🚨 PR-Agent Review Failed",
        );
      }
    });

  return { status: 200, body: { ok: true, triggered: true } };
}

function awaitLocalFs() {
  // dynamic import to avoid loading fs at module scope
  return import("node:fs");
}

let _discordClient: unknown = null;
async function getHttpx() {
  // minimal: use global fetch
  return fetch;
}

async function sendDiscord(webhook: string, content: string, title?: string): Promise<void> {
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "PR-Agent Ops",
        embeds: [{ title, description: content.slice(0, 4000), color: 0x5865f2 }],
      }),
    });
  } catch {
    // never raise
  }
}

// ── server ────────────────────────────────────────────────────────────────

export function startServer(env?: Partial<WebhookEnv>) {
  const cfg = env?.cfg ?? loadConfig();
  const appDir = process.env.PR_AGENT_APP_DIR || "/var/lib/pr-agent-server";
    const privateKeyPem =
      env?.privateKeyPem ??
      (readPrivateKey(process.env.PRIVATE_KEY_PATH || `${appDir}/private-key.pem`) ||
        readPrivateKey(`${appDir}/private-key.pem`) ||
        "");
  const webhookSecret =
    env?.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const analyticsDir =
    env?.analyticsDir ?? (process.env.PR_AGENT_ANALYTICS_DIR || "/var/lib/pr-agent-server/analytics");
  const discordWebhookUrl =
    env?.discordWebhookUrl ?? process.env.DISCORD_WEBHOOK_URL ?? "";
  const discordAlertWebhookUrl =
    env?.discordAlertWebhookUrl ?? process.env.DISCORD_ALERT_WEBHOOK_URL ?? "";

  const fullEnv: WebhookEnv = {
    cfg,
    privateKeyPem,
    webhookSecret,
    analyticsDir,
    discordWebhookUrl,
    discordAlertWebhookUrl,
  };

  const server = Bun.serve({
    port: Number(process.env.PORT || 3000),
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", model: cfg.model });
      }
      if (url.pathname === "/setup/callback") {
        const code = url.searchParams.get("code") || "";
        if (code) {
          try {
            const resp = await fetch(
              `https://api.github.com/app-manifests/${code}/conversions`,
              { headers: { Accept: "application/vnd.github.v3+json" } },
            );
            if (resp.status === 201) {
              const data = (await resp.json()) as {
                id?: number; pem?: string; webhook_secret?: string; slug?: string;
              };
              const creds = {
                app_id: data.id,
                pem: data.pem,
                webhook_secret: data.webhook_secret,
                slug: data.slug,
              };
              await Bun.write(
                `${appDir}/credentials_callback.json`,
                JSON.stringify(creds, null, 2),
              );
              return Response.json({
                status: "success",
                app_id: creds.app_id,
                slug: creds.slug,
              });
            }
          } catch (e) {
            console.error("[callback] conversion failed:", e);
          }
        }
        return Response.json({ status: "ok", message: "callback received" });
      }
      if (url.pathname === "/api/v1/github_webhooks" || url.pathname === "/") {
        if (req.method !== "POST") {
          return Response.json({ ok: true });
        }
        const body = await req.text();
        const sig = req.headers.get("x-hub-signature-256");
        const event = req.headers.get("x-github-event") || "";
        const result = await handleWebhook(fullEnv, body, sig, event);
        return Response.json(result.body, { status: result.status });
      }
      if (url.pathname === "/api/v1/notify_review") {
        if (req.method !== "POST") {
          return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
        }
        try {
          const body = (await req.json()) as {
            repo?: string; pr?: string | number; status?: string;
            summary?: string; score?: string; url?: string;
          };
          const repo = body.repo || "";
          const prNum = String(body.pr ?? "");
          const status = body.status || "done";
          const summary = String(body.summary || "");
          const score = String(body.score || "");
          const url = String(body.url || "");
          const content = `Review ${status} for ${repo}#${prNum}` +
            (score ? ` — score ${score}` : "") + `\n${summary}\n${url}`;
          if (fullEnv.discordWebhookUrl) {
            void sendDiscord(fullEnv.discordWebhookUrl, content).catch(() => {});
          } else {
            console.log(`[notify] ${repo}#${prNum} ${status} ${score} ${url}`);
          }
          return Response.json({ ok: true });
        } catch (e) {
          return Response.json({ ok: false, error: String(e) }, { status: 400 });
        }
      }
      if (url.pathname === "/api/metrics") {
        return new Response(generateMetrics(), {
          headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }
      if (url.pathname === "/api/analytics") {
        const records = readAnalyticsLogs(fullEnv.analyticsDir, 5);
        const recent = [];
        for (const rec of records.slice(-30)) {
          const extra = rec._extra ?? {};
          recent.push({
            time: rec.time?.repr ?? "",
            command: extra.command ?? "",
            message: rec.message ?? "",
            pr_url: extra.pr_url ?? "",
            model: extra.model ?? "",
            level: rec.level?.name ?? "",
          });
        }
        const failures = records.filter((r) => (r.message ?? "").includes("Failed to generate"));
        return Response.json({
          total_events: records.length,
          failure_count: failures.length,
          recent,
          failures: failures.slice(-20).map((r) => ({
            time: r.time?.repr ?? "",
            command: r._extra?.command ?? "",
            model: r._extra?.model ?? "",
            message: (r.message ?? "").slice(0, 200),
          })),
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  console.log(`PR-Agent Bun server listening on :${server.port}`);
  return server;
}

function readPrivateKey(path: string): string {
  try {
    return require("node:fs").readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

interface AnalyticsRecord {
  text?: string;
  record?: AnalyticsRecord;
  message?: string;
  time?: { repr?: string; timestamp?: number };
  level?: { name?: string };
  extra?: Record<string, unknown>;
  _extra?: Record<string, unknown>;
  _file?: string;
}

/** Port of run_server._read_analytics_logs: parse pr-agent.*.log JSON lines
 *  (the legacy Python analytics format) so metrics/analytics endpoints keep
 *  working across the cut-over. Bun also writes its own events in the same
 *  shape (see logReviewEvent). */
export function readAnalyticsLogs(dir: string, maxFiles = 5): AnalyticsRecord[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  let files: string[] = [];
  try {
    // sort by mtime DESC so the newest log files win (pid-based filenames are
    // not naturally ordered — e.g. 616504 vs 806320)
    files = fs
      .readdirSync(dir)
      .filter((f: string) => f.endsWith(".log"))
      .sort((a: string, b: string) => {
        try {
          return fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs;
        } catch {
          return 0;
        }
      });
  } catch {
    return [];
  }
  const records: AnalyticsRecord[] = [];
  for (const f of files.slice(0, maxFiles)) {
    try {
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          let rec = JSON.parse(trimmed) as AnalyticsRecord;
          if (rec.record && typeof rec.record === "object") {
            rec = rec.record as AnalyticsRecord;
          }
          const extra = (rec.extra ?? {}) as Record<string, unknown>;
          if (extra.artifact && typeof extra.artifact === "object") {
            Object.assign(extra, extra.artifact);
            delete extra.artifact;
          }
          rec._extra = extra;
          rec._file = f;
          records.push(rec);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }
  return records;
}

/** Append an analytics event in the legacy pr-agent JSONL shape so external
 *  dashboards that parse pr-agent.*.log keep working. */
export function logReviewEvent(dir: string, event: Record<string, unknown>): void {
  if (!dir) return;
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date();
    const rec = {
      text: "",
      record: {
        time: { repr: ts.toISOString(), timestamp: ts.getTime() / 1000 },
        level: { name: "INFO" },
        message: event.message ?? "review done",
        extra: event.extra ?? {},
        _file: "",
      },
    };
    const file = path.join(dir, `pr-agent.${process.pid}.log`);
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch {
    // analytics must never break the review path
  }
}

function generateMetrics(): string {
  const lines = [
    "# HELP pr_agent_requests_total Total PR-Agent analytics events",
    "# TYPE pr_agent_requests_total counter",
  ];
  const records = readAnalyticsLogs((process.env.PR_AGENT_ANALYTICS_DIR || "/var/lib/pr-agent-server/analytics").trim(), 5);
  let failed = 0;
  let success = 0;
  const commandCounts: Record<string, number> = {};
  const modelFailures: Record<string, number> = {};
  for (const rec of records) {
    const extra = rec._extra ?? {};
    const cmd = (extra.command as string) ?? "unknown";
    commandCounts[cmd] = (commandCounts[cmd] ?? 0) + 1;
    const msg = rec.message ?? "";
    if (msg.includes("Failed to generate") || (msg.toLowerCase().includes("error") && rec.level?.name === "WARNING")) {
      failed++;
      const model = (extra.model as string) ?? "unknown";
      modelFailures[model] = (modelFailures[model] ?? 0) + 1;
    } else {
      success++;
    }
  }
  lines.push(`pr_agent_requests_total{status="success"} ${success}`);
  lines.push(`pr_agent_requests_total{status="failed"} ${failed}`);
  lines.push("# HELP pr_agent_requests_by_command PR-Agent events by command");
  lines.push("# TYPE pr_agent_requests_by_command counter");
  for (const [cmd, cnt] of Object.entries(commandCounts).sort()) {
    lines.push(`pr_agent_requests_by_command{command="${cmd}"} ${cnt}`);
  }
  lines.push("# HELP pr_agent_model_failures PR-Agent model failures by model");
  lines.push("# TYPE pr_agent_model_failures counter");
  for (const [model, cnt] of Object.entries(modelFailures).sort()) {
    lines.push(`pr_agent_model_failures{model="${model}"} ${cnt}`);
  }
  return lines.join("\n") + "\n";
}

// Entry point: `bun src/index.ts` (and the compiled binary) starts the server.
if (import.meta.main) {
  startServer();
}