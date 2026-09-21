// CLI — one-shot review: `bun start --repo owner/name --pr N`
// Also used by the queue worker to trigger reviews without a webhook.

import { loadConfig } from "./config";
import { runReview } from "./review";
import { runDescribe } from "./describe";
import { runImprove } from "./improve";

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
  const keyPath = getArg("--private-key") || process.env.PRIVATE_KEY_PATH || "/opt/pr-agent-server/private-key.pem";
  const fs = await import("node:fs");
  const privateKey = fs.readFileSync(keyPath, "utf-8");
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
}

main().catch((e) => {
  console.error("CLI failed:", (e as Error).message);
  process.exit(1);
});