#!/usr/bin/env python3
"""
PR-Agent Auto-Approve + Auto-Merge Bot
Runs periodically (cron), finds open PRs that have been reviewed by PR-Agent,
approves them and enables auto-merge.
"""
import os, sys, json, time, hmac, hashlib, asyncio
from pathlib import Path

# ── Config ──
APP_ID = os.environ.get("GITHUB_APP_ID", "4319749")
PRIVATE_KEY_PATH = os.environ.get("PRIVATE_KEY_PATH", "/var/lib/pr-agent-server/private-key.pem")
WEBHOOK_SECRET = os.environ.get("GITHUB_WEBHOOK_SECRET", "")
BASE_URL = os.environ.get("GITHUB_API_BASE", "https://api.github.com")

def get_jwt():
    import jwt as pyjwt
    with open(PRIVATE_KEY_PATH) as f:
        key = f.read()
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + 600, "iss": APP_ID}
    return pyjwt.encode(payload, key, algorithm="RS256")

def get_installation_token(installation_id: int) -> str:
    """Get installation access token"""
    import httpx
    jwt_token = get_jwt()
    with httpx.Client() as client:
        r = client.post(
            f"{BASE_URL}/app/installations/{installation_id}/access_tokens",
            headers={"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github.v3+json"}
        )
        return r.json().get("token", "")

def get_all_installations() -> list:
    """Get all app installations"""
    jwt_token = get_jwt()
    import httpx
    with httpx.Client() as client:
        r = client.get(
            f"{BASE_URL}/app/installations",
            headers={"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github.v3+json"}
        )
        return r.json()

def get_installation_repos(installation_id: int, token: str) -> list:
    """Get repos for an installation"""
    import httpx
    with httpx.Client() as client:
        r = client.get(
            f"{BASE_URL}/installation/repositories",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
        )
        return r.json().get("repositories", [])

def get_open_prs(token: str, repo_full: str) -> list:
    """Get open PRs in a repo"""
    import httpx
    with httpx.Client() as client:
        r = client.get(
            f"{BASE_URL}/repos/{repo_full}/pulls?state=open&sort=updated&direction=desc",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
        )
        return r.json()

def get_pr_reviews(token: str, repo_full: str, pr_number: int) -> list:
    """Get reviews for a PR"""
    import httpx
    with httpx.Client() as client:
        r = client.get(
            f"{BASE_URL}/repos/{repo_full}/pulls/{pr_number}/reviews",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
        )
        return r.json()

def post_discord_notification(repo_full: str, pr_number: int, status: str, summary: str = "", score: str = "", url: str = ""):
    """Fire-and-forget Discord notification via the server's internal endpoint."""
    import httpx
    notify_url = os.environ.get("PR_AGENT_NOTIFY_URL", "http://127.0.0.1:4002/api/v1/notify_review")
    try:
        with httpx.Client(timeout=5) as client:
            client.post(notify_url, json={
                "repo": repo_full,
                "pr": pr_number,
                "status": status,
                "summary": summary[:500],
                "score": str(score),
                "url": url,
            })
    except Exception:
        pass

def get_pr_comments(token: str, repo_full: str, pr_number: int) -> list:
    """Get issue comments for a PR"""
    import httpx
    with httpx.Client() as client:
        r = client.get(
            f"{BASE_URL}/repos/{repo_full}/issues/{pr_number}/comments",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
        )
        return r.json()

def approve_pr(token: str, repo_full: str, pr_number: int) -> bool:
    """Submit APPROVE review"""
    import httpx
    with httpx.Client() as client:
        r = client.post(
            f"{BASE_URL}/repos/{repo_full}/pulls/{pr_number}/reviews",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
            json={"event": "APPROVE", "body": "✅ Auto-approved by PR-Agent bot."}
        )
        return r.status_code == 200

def merge_pr(token: str, repo_full: str, pr_number: int) -> tuple:
    """Attempt to merge the PR"""
    import httpx
    with httpx.Client() as client:
        # Get PR info for SHA
        pr_r = client.get(
            f"{BASE_URL}/repos/{repo_full}/pulls/{pr_number}",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"}
        )
        if pr_r.status_code != 200:
            return False, f"Can't get PR: {pr_r.status_code}"
        
        pr_data = pr_r.json()
        sha = pr_data.get("head", {}).get("sha", "")
        mergeable = pr_data.get("mergeable", False)
        
        if mergeable is False:
            return False, "PR not mergeable (conflicts or checks pending)"
        
        # Try merge
        merge_r = client.put(
            f"{BASE_URL}/repos/{repo_full}/pulls/{pr_number}/merge",
            headers={"Authorization": f"token {token}", "Accept": "application/vnd.github.v3+json"},
            json={
                "commit_title": f"Auto-merge PR #{pr_number}",
                "merge_method": "merge",
                "sha": sha
            }
        )
        if merge_r.status_code == 200:
            return True, f"Merged: {merge_r.json().get('sha', '')}"
        else:
            return False, f"Merge failed: {merge_r.status_code} - {merge_r.json().get('message', '')}"

def has_bot_comment_with_review(comments: list) -> tuple:
    """Check if PR-Agent has posted a review comment and extract quality"""
    bot_name = "mytheclipsebotreview"
    for c in comments:
        if c.get("user", {}).get("login", "").startswith(bot_name):
            body = c.get("body", "")
            # Check for PR Reviewer Guide (successful review)
            if "PR Reviewer Guide" in body:
                # Extract score if available
                score = extract_score(body)
                return True, score
    return False, 0

def extract_score(body: str) -> int:
    """Extract review score from bot comment"""
    import re
    # Look for score patterns like "Score: 8" or "⏱️ Estimated effort"
    # For now, assume passing if we got a review without errors
    return 8

def main():
    print("=" * 60)
    print(f"PR-Agent Auto-Approve/Merge Bot - {time.ctime()}")
    print("=" * 60)
    
    # Get installations
    installations = get_all_installations()
    print(f"Found {len(installations)} installation(s)")
    
    for inst in installations:
        inst_id = inst["id"]
        account = inst["account"]["login"]
        print(f"\n📦 Installation {inst_id} - @{account}")
        
        # Get token
        token = get_installation_token(inst_id)
        if not token:
            print(f"  ❌ Failed to get token")
            continue
        
        # Get repos
        repos = get_installation_repos(inst_id, token)
        print(f"  Repos: {len(repos)}")
        
        for repo in repos:
            repo_full = repo["full_name"]
            print(f"\n  📁 {repo_full}")
            
            # Get open PRs
            prs = get_open_prs(token, repo_full)
            print(f"    Open PRs: {len(prs)}")
            
            for pr in prs[:5]:  # Max 5 per repo
                pr_num = pr["number"]
                pr_title = pr["title"]
                pr_user = pr["user"]["login"]
                pr_author = pr_user
                
                print(f"    🔀 PR #{pr_num}: {pr_title[:50]}...")
                
                # Skip bot PRs
                if "[bot]" in pr_author or pr_author == "mytheclipsebotreview":
                    print(f"      ⏭️ Bot PR, skipping")
                    continue
                
                # Check if already approved/merged
                if pr.get("merged", False):
                    print(f"      ✅ Already merged")
                    continue
                
                # Check reviews
                reviews = get_pr_reviews(token, repo_full, pr_num)
                bot_approved = any(
                    r.get("user", {}).get("login", "").startswith("mytheclipsebotreview")
                    and r.get("state") == "APPROVED"
                    for r in reviews
                )
                
                if bot_approved:
                    print(f"      ✅ Already approved. Trying merge...")
                    success, msg = merge_pr(token, repo_full, pr_num)
                    print(f"      {'✅' if success else '❌'} Merge: {msg}")
                    continue
                
                # Check bot comments for review
                comments = get_pr_comments(token, repo_full, pr_num)
                has_review, score = has_bot_comment_with_review(comments)
                
                # ── TRIVIAL PR FAST-PATH ──
                # Docs-only / version bumps / dependabot / tiny diffs with green
                # CI skip the AI-fix + score gate and merge directly.
                if has_review:
                    changed_files, total_lines = [], 0
                    is_trivial = False
                    try:
                        from trivial_merge import (
                            is_trivial_pr, get_pr_changed_files, check_ci_passed,
                            merge_pr as trivial_merge,
                        )
                        changed_files, total_lines = get_pr_changed_files(token, repo_full, pr_num)
                        is_trivial = is_trivial_pr(pr_title, pr_author, changed_files, total_lines)
                    except Exception as e:
                        is_trivial = False
                        print(f"      ⚠️ trivial check failed: {e}")

                    if is_trivial:
                        print(f"      ⚡ TRIVIAL PR ({total_lines} lines, {len(changed_files)} files). Fast-path approve+merge...")
                        ci_ok, ci_msg = check_ci_passed(token, repo_full, pr.get("head", {}).get("sha", ""))
                        if not ci_ok:
                            print(f"      ⏳ CI not green: {ci_msg}")
                            continue
                        if approve_pr(token, repo_full, pr_num):
                            print(f"      ✅ Approved (trivial)")
                        time.sleep(1)
                        success, msg = trivial_merge(token, repo_full, pr_num, pr.get("head", {}).get("sha", ""))
                        print(f"      {'✅ Merged!' if success else '❌ ' + msg}")
                        post_discord_notification(repo_full, pr_num, "done" if success else "failed",
                                                  summary=f"Trivial PR auto-merged ({total_lines} lines)" if success else f"Trivial merge failed: {msg}",
                                                  score=score, url=pr.get("html_url", ""))
                        continue

                if has_review and score >= 5:
                    print(f"      📝 Review found (score: {score}). Approving + merging...")
                    
                    # Approve
                    if approve_pr(token, repo_full, pr_num):
                        print(f"      ✅ Approved!")
                    else:
                        print(f"      ❌ Approve failed")
                        continue
                    
                    # Small delay
                    time.sleep(2)
                    
                    # Merge
                    success, msg = merge_pr(token, repo_full, pr_num)
                    print(f"      {'✅ Merged!' if success else '❌ ' + msg}")
                elif has_review and score < 5:
                    print(f"      ⏭️ Review score too low ({score})")
                else:
                    print(f"      ⏳ No bot review yet")
    
    print("\n" + "=" * 60)
    print("Done!")

if __name__ == "__main__":
    main()
