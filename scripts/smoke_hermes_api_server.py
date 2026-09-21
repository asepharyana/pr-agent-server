#!/usr/bin/env python3
"""Standalone smoke test for the Hermes gateway API server adapter.

Starts APIServerAdapter on a private port (default 8643) using the LIVE hermes
install, then drives a real agent turn through POST /v1/chat/completions —
proving the whole path the pr-queue-worker depends on:

    bearer auth -> route -> AIAgent -> toolset (terminal/file) -> response

No gateway restart needed and nothing in the running gateway is touched.
"""
import argparse
import asyncio
import json
import os
import sys
import time

INSTALL = os.environ.get("HERMES_INSTALL", "/home/code/.hermes/hermes-agent")
sys.path.insert(0, INSTALL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8643)
    ap.add_argument("--key", default="standalone-smoke-key-0123456789abcdef")
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--timeout", type=float, default=300.0)
    ap.add_argument("--keep-alive", action="store_true", help="serve until Ctrl-C")
    args = ap.parse_args()

    os.environ["API_SERVER_KEY"] = args.key
    os.environ["API_SERVER_HOST"] = "127.0.0.1"
    os.environ["API_SERVER_PORT"] = str(args.port)

    from gateway.config import PlatformConfig, Platform
    from gateway.platforms.api_server import APIServerAdapter

    cfg = PlatformConfig(enabled=True, extra={"host": "127.0.0.1", "port": args.port, "key": args.key})
    adapter = APIServerAdapter(cfg)
    print(f"[smoke] starting API server adapter on 127.0.0.1:{args.port}", flush=True)

    async def run():
        ok = await adapter.connect()
        print(f"[smoke] connect() -> {ok}", flush=True)
        if not ok:
            err = getattr(adapter, "_fatal_error", None) or getattr(adapter, "fatal_error", None)
            print(f"[smoke] fatal: {err}", flush=True)
            return 1
        if args.keep_alive:
            print("[smoke] serving — Ctrl-C to stop", flush=True)
            while True:
                await asyncio.sleep(3600)
        await asyncio.sleep(0.5)

        import httpx
        prompt = args.prompt or (
            "Use your terminal tool to run exactly: echo HERMES_API_OK && pwd\n"
            "Then reply with the raw output only."
        )
        body = {
            "model": "hermes-agent",
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }
        url = f"http://127.0.0.1:{args.port}/v1/chat/completions"
        t0 = time.time()
        try:
            async with httpx.AsyncClient(timeout=args.timeout) as client:
                r = await client.post(url, headers={"Authorization": f"Bearer {args.key}"}, json=body)
            dt = time.time() - t0
            print(f"[smoke] HTTP {r.status_code} in {dt:.1f}s", flush=True)
            print("[smoke] body:", r.text[:1500], flush=True)
            if r.status_code != 200:
                return 1
            data = r.json()
            text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            print(f"[smoke] agent text: {text[:400]!r}", flush=True)
            if "HERMES_API_OK" not in text:
                print("[smoke] FAIL: terminal tool output not present in the answer", flush=True)
                return 1
            print("[smoke] PASS: agent ran a real terminal tool through the API server", flush=True)
            return 0
        except Exception as exc:
            print(f"[smoke] request failed: {type(exc).__name__}: {exc}", flush=True)
            return 1

    try:
        return asyncio.run(run())
    finally:
        try:
            asyncio.run(adapter.disconnect())
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
