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
  const candidates = [
    join(appDir, "private-key.pem"),
    join(process.env.HOME ?? "/home/code", ".hermes", "keys", "pr-agent-key.pem"),
  ];
  let privateKey = "";
  for (const p of candidates) {
    try {
      privateKey = readFileSync(p, "utf8");
      break;
    } catch {
      // try next
    }
  }
  if (!privateKey) throw new Error(`private-key.pem not found in ${candidates.join(", ")}`);
  let omniKey = "";
  for (const p of [join(appDir, "omniroute_key"), join(process.env.HOME ?? "/home/code", ".hermes", "omniroute_key")]) {
    try {
      omniKey = readFileSync(p, "utf8").trim();
      if (omniKey) break;
    } catch {
      // try next
    }
  }
  if (!omniKey) throw new Error(`omniroute_key not found in ${appDir}`);
  return {
    appId: opts?.appId ?? 4319749,
    privateKey,
    webhookSecret: opts?.webhookSecret ?? "",
    omniKey,
    baseUrl: process.env.PR_AGENT_BASE_URL ?? "https://9router.asepharyana.my.id/v1",
  };
}