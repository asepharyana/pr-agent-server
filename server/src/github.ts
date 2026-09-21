// GitHub App provider — port of pr_agent.git_providers.github_provider.
// Uses @octokit/auth-app for JWT→installation token and @octokit/rest for the
// REST calls the review pipeline needs. Rate-limit-aware retry.

import { createAppAuth, type AppAuthentication } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "./config";
import { EditType, type FilePatchInfo } from "./diff";
import { isGeneratedOrInvalidFile } from "./diff";
// NOTE: with Bun we must NOT pass a Promise-returning `auth()` to Octokit —
// @octokit/core's token authStrategy expects a STRING and calls .then on the
// returned value. Instead we pass a custom authStrategy that injects a
// `Bearer <installationToken>` header (updated lazily).

export interface PullRequestData {
  number: number;
  title: string;
  body: string;
  state: string;
  head: { ref: string; sha: string; repo?: { name: string; owner?: { login: string } } };
  base: { ref: string; sha: string };
  htmlUrl: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface GhComment {
  id: number;
  body: string;
  htmlUrl: string;
  createdAt: string;
}

const MAX_FILES_ALLOWED_FULL = 50;

export class GitHubProvider {
  private octokit: Octokit;
  private appClient!: Octokit;
  private appAuth: ReturnType<typeof createAppAuth>;
  private auth: AppAuthentication | null = null;
  private authExpiresAt = 0;
  private installationToken: string | null = null;
  readonly repo: string; // owner/name
  readonly prNumber: number;
  private pr: PullRequestData | null = null;
  private diffs: FilePatchInfo[] | null = null;
  private repoObjCache: { languages?: Record<string, number> } = {};

  constructor(
    private cfg: Config,
    repoOwner: string,
    repoName: string,
    prNumber: number,
    privateKeyPem: string,
  ) {
    this.repo = `${repoOwner}/${repoName}`;
    this.prNumber = prNumber;
    const baseUrl = cfg.github.baseUrl;
    this.appAuth = createAppAuth({
      appId: cfg.github.appId,
      privateKey: privateKeyPem,
    });
    // App-level client: uses JWT (type: 'app'), only for discovering
    // installation id (GET /repos/{owner}/{repo}/installation needs app JWT).
    this.appClient = new Octokit({
      baseUrl,
      authStrategy: () => ({
        hook: async (request: any, options: Record<string, any>) => {
          const jwtAuth = await this.appAuth({ type: "app" });
          options.headers = options.headers ?? {};
          options.headers.authorization = `Bearer ${jwtAuth.token}`;
          options.headers["x-github-api-version"] = "2022-11-28";
          return request(options);
        },
      }),
      request: { timeout: 20_000 },
    });
    // Installation-level client: bearer token per repo.
    this.octokit = new Octokit({
      baseUrl,
      authStrategy: this.installTokenStrategy.bind(this),
      throttle: {
        enabled: true,
        onRateLimit: () => true,
        onSecondaryRateLimit: () => true,
      },
      request: { timeout: 20_000 },
    });
  }

  // Custom auth strategy: inject `Authorization: Bearer <installation token>`
  // lazily on every request (token refreshed on expiry).
  private installTokenStrategy(): { hook: (request: unknown, options: Record<string, any>) => unknown } {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook: (request: any, options: { headers?: Record<string, string>; [k: string]: any }) => {
        const token = this.installationToken;
        if (!token) {
          // force fetch (async); can't await in hook — pre-fetch synchronously
          void this.getInstallationToken().then((t) => {
            options.headers = options.headers ?? {};
            options.headers.authorization = `Bearer ${t}`;
          });
        } else {
          options.headers = options.headers ?? {};
          options.headers.authorization = `Bearer ${token}`;
        }
        return request(options);
      },
    };
  }

  private async getInstallationToken(): Promise<string> {
    // refresh ~1 minute before expiry
    if (this.installationToken && this.authExpiresAt && Date.now() < this.authExpiresAt - 60_000) {
      return this.installationToken;
    }
    const [owner, repo] = this.repo.split("/");
    // list repository installations to discover installation id (uses app JWT)
    const { data: installs } = await fetchInstallations(this.appClient, owner, repo, this.cfg);
    const inst = installs[0];
    if (!inst) throw new Error(`No GitHub App installation for ${this.repo}`);
    const auth = await this.appAuth({ type: "installation", installationId: inst.id });
    this.auth = auth as unknown as AppAuthentication;
    this.authExpiresAt = Date.now() + new Date(auth.expiresAt).getTime() - Date.now() - 60_000;
    this.installationToken = this.auth.token;
    return this.installationToken;
  }

  async ensureInstallationToken(): Promise<string> {
    return this.getInstallationToken();
  }

  async getPr(): Promise<PullRequestData> {
    if (this.pr) return this.pr;
    await this.ensureInstallationToken();
    const [owner, repo] = this.repo.split("/");
    const { data } = await this.retry(() =>
      this.octokit.pulls.get({ owner, repo, pull_number: this.prNumber }),
    );
    this.pr = {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      state: data.state ?? "",
      head: {
        ref: data.head.ref,
        sha: data.head.sha,
        repo: {
          name: data.head.repo?.name,
          owner: { login: data.head.repo?.owner?.login },
        },
      },
      base: { ref: data.base.ref, sha: data.base.sha },
      htmlUrl: data.html_url,
      additions: data.additions ?? 0,
      deletions: data.deletions ?? 0,
      changedFiles: data.changed_files ?? 0,
    };
    return this.pr;
  }

  async getPrDescription(full = true): Promise<string> {
    await this.ensureInstallationToken();
    const pr = await this.getPr();
    return (full ? pr.body : pr.body) || "";
  }

  async getTitle(): Promise<string> {
    const pr = await this.getPr();
    return pr.title;
  }

  async getPrBranch(): Promise<string> {
    await this.ensureInstallationToken();
    const pr = await this.getPr();
    return pr.head.ref;
  }

  async getCommits(): Promise<string[]> {
    await this.ensureInstallationToken();
    const [owner, repo] = this.repo.split("/");
    const { data } = await this.retry(() =>
      this.octokit.pulls.listCommits({ owner, repo, pull_number: this.prNumber, per_page: 100 }),
    );
    return data.map((c) => c.commit?.message ?? "");
  }

  async getCommitMessagesStr(maxTokens: number): Promise<string> {
    const messages = await this.getCommits();
    const str = messages.map((m, i) => `${i + 1}. ${m}`).join("\n");
    return str; // caller clips with maxTokens
  }

  async getLanguages(): Promise<Record<string, number>> {
    await this.ensureInstallationToken();
    const [owner, repo] = this.repo.split("/");
    const resp = await this.retry(() =>
      this.octokit.rest.repos.listLanguages({ owner, repo }),
    );
    return resp.data as unknown as Record<string, number>;
  }

  async getRepoFileContent(path: string, ref: string): Promise<string> {
    const [owner, repo] = this.repo.split("/");
    try {
      const { data } = await this.retry(() =>
        this.octokit.repos.getContent({ owner, repo, path, ref }),
      );
      if (Array.isArray(data)) return "";
      if (!("content" in data) || typeof data.content !== "string") return "";
      return Buffer.from(data.content, "base64").toString("utf-8");
    } catch {
      return "";
    }
  }

  async getMergeBaseSha(): Promise<string> {
    const pr = await this.getPr();
    const [owner, repo] = this.repo.split("/");
    try {
      const { data } = await this.retry(() =>
        this.octokit.repos.compareCommits({
          owner,
          repo,
          base: pr.base.sha,
          head: pr.head.sha,
        }),
      );
      return data.merge_base_commit?.sha ?? pr.base.sha;
    } catch {
      return pr.base.sha;
    }
  }

  async getDiffFiles(): Promise<FilePatchInfo[]> {
    await this.ensureInstallationToken();
    if (this.diffs) return this.diffs;
    const pr = await this.getPr();
    const mergeBaseSha = await this.getMergeBaseSha();
    const [owner, repo] = this.repo.split("/");

    const { data: files } = await this.retry(() =>
      this.octokit.pulls.listFiles({ owner, repo, pull_number: this.prNumber, per_page: 100 }),
    );

    const diffFiles: FilePatchInfo[] = [];
    let counterValid = 0;
    for (const f of files) {
      const filename = f.filename;
      if (!filename || isGeneratedOrInvalidFile(filename)) continue;

      let patch = f.patch ?? "";
      let newContent = "";
      let baseContent = "";
      counterValid++;
      const avoidLoad = counterValid >= MAX_FILES_ALLOWED_FULL && patch.length > 0;
      if (!avoidLoad) {
        newContent = await this.getRepoFileContent(filename, pr.head.sha);
        baseContent = await this.getRepoFileContent(filename, mergeBaseSha);
      }
      if (!patch) {
        // build diff from base/head
        patch = buildLargeDiff(filename, baseContent, newContent);
      }
      if (!patch) continue;

      let editType: EditType;
      switch (f.status) {
        case "added": editType = EditType.ADDED; break;
        case "removed": editType = EditType.DELETED; break;
        case "renamed": editType = EditType.RENAMED; break;
        default: editType = EditType.MODIFIED;
      }
      const numPlus = f.additions ?? 0;
      const numMinus = f.deletions ?? 0;
      diffFiles.push({
        filename,
        baseFile: baseContent,
        headFile: newContent,
        patch,
        editType,
        numPlusLines: numPlus,
        numMinusLines: numMinus,
      });
    }
    this.diffs = diffFiles;
    return diffFiles;
  }

  // ── publishing ──────────────────────────────────────────────────────────

  async publishComment(body: string, isTemporary = false): Promise<GhComment> {
    await this.ensureInstallationToken();
    const [owner, repo] = this.repo.split("/");
    const { data } = await this.retry(() =>
      this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: this.prNumber,
        body,
      }),
    );
    return {
      id: data.id,
      body: data.body ?? "",
      htmlUrl: data.html_url,
      createdAt: data.created_at,
    };
  }

  async editComment(commentId: number, body: string): Promise<void> {
    const [owner, repo] = this.repo.split("/");
    await this.retry(() =>
      this.octokit.issues.updateComment({ owner, repo, comment_id: commentId, body }),
    );
  }

  async deleteComment(commentId: number): Promise<void> {
    const [owner, repo] = this.repo.split("/");
    await this.retry(() =>
      this.octokit.issues.deleteComment({ owner, repo, comment_id: commentId }),
    );
  }

  async listIssueComments(): Promise<GhComment[]> {
    const [owner, repo] = this.repo.split("/");
    const { data } = await this.retry(() =>
      this.octokit.issues.listComments({ owner, repo, issue_number: this.prNumber, per_page: 100 }),
    );
    return data.map((c) => ({
      id: c.id,
      body: c.body ?? "",
      htmlUrl: c.html_url,
      createdAt: c.created_at,
    }));
  }

  async addLabels(labelNames: string[]): Promise<void> {
    const [owner, repo] = this.repo.split("/");
    if (!labelNames.length) return;
    await this.retry(() =>
      this.octokit.issues.addLabels({ owner, repo, issue_number: this.prNumber, labels: labelNames }),
    );
  }

  async getPrUrl(): Promise<string> {
    const pr = await this.getPr();
    return pr.htmlUrl;
  }

  /** Persistent comment: find a previous comment starting with `header` and
   *  update it in place; else create new. Mirrors pr_agent behavior. */
  async publishPersistentComment(
    content: string,
    initialHeader: string,
    name = "review",
    finalUpdateMessage = true,
  ): Promise<void> {
    const comments = await this.listIssueComments();
    for (const c of comments) {
      if (c.body.startsWith(initialHeader)) {
        const latestCommitUrl = await this.getLatestCommitUrl();
        const updatedHeader = `${initialHeader}\n\n#### (${name.charAt(0).toUpperCase() + name.slice(1)} updated until commit ${latestCommitUrl})\n`;
        const updated = c.body
          ? content.replace(initialHeader, updatedHeader)
          : content;
        await this.editComment(c.id, updated);
        if (finalUpdateMessage) {
          await this.publishComment(
            `**[Persistent ${name}](<${c.htmlUrl}>)** updated to latest commit [${latestCommitUrl}](${latestCommitUrl})`,
          );
        }
        return;
      }
    }
    await this.publishComment(content);
  }

  async getLatestCommitUrl(): Promise<string> {
    const pr = await this.getPr();
    return pr.head.sha;
  }

  async removeInitialComment(initialBodyContains: string): Promise<void> {
    const comments = await this.listIssueComments();
    for (const c of comments) {
      if (c.body.includes(initialBodyContains) && c.body.includes("Preparing review")) {
        await this.deleteComment(c.id);
      }
    }
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.cfg.github.rateLimitRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const err = e as { status?: number; message?: string };
        // retry only on rate limit-ish errors
        if (err.status === 403 || err.status === 429 || (err.message ?? "").includes("rate limit")) {
          const delay =
            this.cfg.github.rateLimitDelaySec * Math.pow(2, attempt) * 1000 +
            Math.random() * 1000;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }
}

async function fetchInstallations(
  octokit: Octokit,
  owner: string,
  repo: string,
  cfg: Config,
): Promise<{ data: { id: number }[] }> {
  // try direct repo-scoped lookup first: GET /repos/{owner}/{repo}/installation
  try {
        const { data } = await octokit.request("GET /repos/{owner}/{repo}/installation", {
          owner,
          repo,
        });
        return { data: [{ id: (data as { id: number }).id }] };
      } catch {
        // fall back to listing app installations and filtering by repo
        const { data } = await octokit.request("GET /app/installations", {
          per_page: 100,
        });
        const insts: { id: number }[] = [];
        for (const inst of data as { id: number; account?: { login?: string } }[]) {
          try {
            const resp = await octokit.request("GET /installation/repositories", {
              per_page: 100,
            });
            const found = (
              resp.data as unknown as { repositories: { full_name?: string }[] }
            ).repositories.some((r) => r.full_name === `${owner}/${repo}`);
            if (found) insts.push({ id: inst.id });
          } catch {
            // skip
          }
        }
        return { data: insts };
      }
}

function buildLargeDiff(filename: string, baseContent: string, headContent: string): string {
  if (!baseContent && !headContent) return "";
  if (baseContent === headContent) return "";
  const baseLines = baseContent.split("\n");
  const headLines = headContent.split("\n");
  // Simple whole-file diff: present as full add or full delete
  if (!baseContent) {
    return `@@ -0,0 +1,${headLines.length} @@\n${headLines.map((l) => "+" + l).join("\n")}`;
  }
  if (!headContent) {
    return `@@ -1,${baseLines.length} +0,0 @@\n${baseLines.map((l) => "-" + l).join("\n")}`;
  }
  // fallback: whole-file replace (approximation)
  return `@@ -1,${baseLines.length} +1,${headLines.length} @@\n${baseLines
    .map((l) => "-" + l)
    .concat(headLines.map((l) => "+" + l))
    .join("\n")}`;
}