// Bun PR-Agent re-implementation — secrets loader (local dev/test only).
// Reads the same secrets the systemd unit uses; never committed.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Secrets {
  appId: number;
  privateKey: string;
  webhookSecret: string;
  omniKey: string;
  baseUrl: string;
}

export function loadSecrets(opts?: {
  appDir?: string;
  appId?: number;
  webhookSecret?: string;
}): Secrets {
  const appDir = opts?.appDir ?? "/var/lib/pr-agent-server";
  const privateKey = readFileSync(join(appDir, "private-key.pem"), "utf8");
  const omniKey = readFileSync(join(appDir, "omniroute_key"), "utf8").trim();
  return {
    appId: opts?.appId ?? 4319749,
    privateKey,
    webhookSecret: opts?.webhookSecret ?? "",
    omniKey,
    baseUrl: process.env.PR_AGENT_BASE_URL ?? "https://9router.asepharyana.my.id/v1",
  };
}