// CLI — one-shot review: `bun start --repo owner/name --pr N`
// Also used by the queue worker to trigger reviews without a webhook.

import { loadConfig } from "./config";
import { runReview } from "./review";
import { runDescribe } from "./describe";
import { runImprove } from "./improve";
import { logReviewEvent } from "./index";
import { join } from "node:path";

const ANALYTICS_DIR = process.env.PR_AGENT_ANALYTICS_DIR || "/var/lib/pr-agent-server/analytics";

function recordAnalytics(command: string, result: { status?: string; model?: string }): void {
  try {
    logReviewEvent(ANALYTICS_DIR, {
      message: result.status === "success" ? "Generated code suggestions" : `Failed to generate (${result.status ?? "error"})`,
      extra: {
        command,
        pr_url_short: "",
        model: result.model ?? "",
        error: result.status === "success" ? "" : (result.status ?? "error"),
      },
    });
  } catch {
    // analytics is best-effort; never fail the CLI on a log write
  }
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (name: string): boolean => args.includes(name);

  if (has("--help")) {
    console.log(
      "Usage: bun src/cli.ts --repo owner/name --pr N [--tool review|describe] [--private-key PATH] [--no-publish]",
    );
    return;
  }

  const repoArg = getArg("--repo");
  const prArg = getArg("--pr");
  if (!repoArg || !prArg) {
    console.error("Missing --repo owner/name or --pr N");
    process.exit(1);
  }
  const [owner, repo] = repoArg.split("/");
  const prNumber = Number(prArg);
  const tool = getArg("--tool") || "review";

  const cfg = loadConfig();
  const keyPath =
    getArg("--private-key") ||
    process.env.PRIVATE_KEY_PATH ||
    "/opt/pr-agent-server/private-key.pem";
  const fs = await import("node:fs");
  const fallbackKey = join(process.env.HOME ?? "/home/code", ".hermes", "keys", "pr-agent-key.pem");
  let privateKey: string;
  try {
    privateKey = fs.readFileSync(keyPath, "utf-8");
  } catch {
    privateKey = fs.readFileSync(fallbackKey, "utf-8"); // EACCES/ENOENT on /opt → user-local copy
  }
  const publish = !has("--no-publish");

  if (tool === "describe") {
    const result = await runDescribe(cfg, owner, repo, prNumber, privateKey, {
      publish,
    });
    console.log(JSON.stringify(
      {
        tool: "describe",
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        markdownLen: result.markdown.length,
      },
      null,
      2,
    ));
    console.log("\n--- MARKDOWN ---\n");
    console.log(result.markdown);
    recordAnalytics("describe", result);
    return;
  }

  if (tool === "improve") {
    const result = await runImprove(cfg, owner, repo, prNumber, privateKey, {
      publish,
    });
    console.log(JSON.stringify(
      {
        tool: "improve",
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        markdownLen: result.markdown.length,
      },
      null,
      2,
    ));
    console.log("\n--- MARKDOWN ---\n");
    console.log(result.markdown);
    recordAnalytics("improve", result);
    return;
  }

  const result = await runReview(cfg, owner, repo, prNumber, privateKey, {
    publish,
  });

  console.log(JSON.stringify(
    {
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      cachedTokens: result.cachedTokens,
      remainingFiles: result.remainingFiles.length,
      markdownLen: result.markdown.length,
    },
    null,
    2,
  ));
  console.log("\n--- MARKDOWN ---\n");
  console.log(result.markdown);
  recordAnalytics("review", result);
}

main().catch((e) => {
  console.error("CLI failed:", (e as Error).message);
  process.exit(1);
});