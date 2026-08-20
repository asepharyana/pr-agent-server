#!/usr/bin/env python3
"""PR-Agent Trivial PR Auto-Merge — enhances auto_merge_bot.py with trivial-PR fast-path.

Logic:
  - PR with bot review comment ("PR Reviewer Guide") + score >= 5
  - AND is_trivial (docs-only, version bump, dependency bump, < small diff)
  → skip AI fix, approve + merge directly if CI is green.

This file is imported/executed by auto_merge_bot.py; keep it standalone and
dependency-light (httpx, pyjwt).
"""
import os, re, time, json
from pathlib import Path

# ── Config ──
APP_ID = os.environ.get("GITHUB_APP_ID", "4319749")
PRIVATE_KEY_PATH = os.environ.get("PRIVATE_KEY_PATH", "/var/lib/pr-agent-server/private-key.pem")
BASE_URL = os.environ.get("GITHUB_API_BASE", "https://api.github.com")
BOT_LOGIN = os.environ.get("PR_AGENT_BOT_LOGIN", "mytheclipsebotreview")
TRIVIAL_MAX_DIFF_LINES = int(os.environ.get("TRIVIAL_MAX_DIFF_LINES", "100"))
TRIVIAL_MAX_FILES = int(os.environ.get("TRIVIAL_MAX_FILES", "5"))

TRIVIAL_TITLE_RE = re.compile(
    r"(dependabot|update|upgrade|bump|chore\(deps\)|pin dependencies|"
    r"docs?[:\(]|version|release|backport|typo|fix typo|minor|patch)",
    re.IGNORECASE,
)
TRIVIAL_FILE_RE = re.compile(
    r"(\.md$|\.txt$|\.lock$|\.gitignore$|\.dockerignore$|README|LICENSE|"
    r"CHANGELOG|package\.json$|pyproject\.toml$|Cargo\.toml$|go\.mod$|Gemfile\.lock$|"
    r"requirements.*\.txt$|\.github/workflows/|\.env\.example$)",
    re.IGNORECASE,
)


def is_trivial_pr(title: str, author: str, changed_files: list, total_lines: int) -> bool:
    """Determine if a PR is 'trivial' — safe to auto-merge without AI fix."""
    if author == BOT_LOGIN or "[bot]" in author:
        return True
    if total_lines > TRIVIAL_MAX_DIFF_LINES:
        return False
    if len(changed_files) > TRIVIAL_MAX_FILES:
        return False
    if TRIVIAL_TITLE_RE.search(title):
        return True
    # all changed files trivial?
    if changed_files and all(TRIVIAL_FILE_RE.search(f) for f in changed_files):
        return True
    return False


def get_pr_changed_files(token: str, repo_full: str, pr_number: int) -> tuple:
    """Return (changed_files: list, total_added+deleted: int) via GitHub API."""
    import httpx
    files = []
    total = 0
    page = 1
    with httpx.Client(timeout=30) as client:
        while True:
            r = client.get(
                f"{BASE_URL}/repos/{repo_full}/pulls/{pr_number}/files",
                params={"per_page": 100, "page": page},
                headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
            )
            if r.status_code != 200:
                break
            batch = r.json()
            if not batch:
                break
            for f in batch:
                files.append(f.get("filename", ""))
                total += f.get("additions", 0) + f.get("deletions", 0)
            if len(batch) < 100:
                break
            page += 1
    return files, total


def check_ci_passed(token: str, repo_full: str, sha: str) -> tuple:
    """Check GitHub check-runs/status for a SHA. Returns (ok, msg)."""
    import httpx
    with httpx.Client(timeout=30) as client:
        r = client.get(
            f"{BASE_URL}/repos/{repo_full}/commits/{sha}/check-runs",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
        )
        if r.status_code == 200:
            data = r.json()
            runs = data.get("check_runs", [])
            if not runs:
                return True, "No CI configured"
            for run in runs:
                status = run.get("status", "")
                conclusion = run.get("conclusion")
                if status != "completed":
                    return False, f"Check pending: {run.get('name','?')}"
                if conclusion not in ("success", "neutral", "skipped"):
                    return False, f"Check failed: {run.get('name','?')} → {conclusion}"
            return True, f"CI green ({len(runs)} checks)"
        # fallback to statuses
        r2 = client.get(
            f"{BASE_URL}/repos/{repo_full}/commits/{sha}/status",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
        )
        if r2.status_code == 200:
            st = r2.json().get("state", "")
            if st == "success":
                return True, "Status success"
            if st == "pending":
                return False, "Status pending"
            return False, f"Status {st}"
        return True, "No CI configured"


def approve_pr(token: str, repo_full: str, pr_number: int) -> int:
    import httpx
    with httpx.Client(timeout=30) as client:
        r = client.post(
            f"{BASE_URL}/repos/{repo_full}/pulls/{pr_number}/reviews",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
            json={"event": "APPROVE", "body": "✅ Auto-approved (trivial PR)."},
        )
        return r.status_code


def merge_pr(token: str, repo_full: str, pr_number: int, sha: str) -> tuple:
    import httpx
    with httpx.Client(timeout=30) as client:
        r = client.put(
            f"{BASE_URL}/repos/{repo_full}/pulls/{pr_number}/merge",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
            json={"commit_title": f"Auto-merge trivial PR #{pr_number}", "merge_method": "squash", "sha": sha},
        )
        if r.status_code == 200:
            return True, f"Merged: {r.json().get('sha','?')}"
        return False, f"Merge failed: {r.status_code} - {r.json().get('message','')}"
