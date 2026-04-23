#!/usr/bin/env python3
"""Scrape every article from the evalyze.substack.com publication.

Uses Substack's public archive API to enumerate posts, then downloads each
post's HTML and extracts a readable text version. Loops until the archive
is exhausted.
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

PUB = "evalyze"
BASE = f"https://{PUB}.substack.com"
ARCHIVE = f"{BASE}/api/v1/archive"
PAGE_SIZE = 50
OUT_DIR = Path(__file__).parent / "articles"
INDEX_PATH = Path(__file__).parent / "index.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json, text/html;q=0.9,*/*;q=0.8",
}


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")[:120] or "post"


def fetch_with_retry(url: str, *, params: dict | None = None, attempts: int = 5) -> requests.Response:
    delay = 2.0
    last: Exception | None = None
    for i in range(attempts):
        try:
            resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
            if resp.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"retryable {resp.status_code}")
            resp.raise_for_status()
            return resp
        except Exception as exc:
            last = exc
            if i == attempts - 1:
                break
            print(f"  retry {i + 1}/{attempts} after error: {exc}; sleeping {delay:.1f}s")
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"failed after {attempts} attempts: {last}")


def list_all_posts() -> list[dict]:
    posts: list[dict] = []
    seen: set[int] = set()
    offset = 0
    while True:
        params = {"sort": "new", "limit": PAGE_SIZE, "offset": offset}
        resp = fetch_with_retry(ARCHIVE, params=params)
        batch = resp.json()
        if not batch:
            break
        new = 0
        for p in batch:
            pid = p.get("id")
            if pid in seen:
                continue
            seen.add(pid)
            posts.append(p)
            new += 1
        print(f"  fetched {len(batch)} (new={new}) offset={offset} total={len(posts)}")
        if len(batch) < PAGE_SIZE or new == 0:
            break
        offset += PAGE_SIZE
        time.sleep(0.5)
    return posts


def extract_article(html: str) -> tuple[str, str]:
    soup = BeautifulSoup(html, "html.parser")
    title_el = soup.find("h1")
    title = title_el.get_text(strip=True) if title_el else ""
    body = soup.find("div", class_=re.compile(r"available-content|body markup"))
    if body is None:
        body = soup.find("article") or soup
    for tag in body.find_all(["script", "style", "noscript"]):
        tag.decompose()
    text = body.get_text("\n", strip=True)
    return title, text


def download_post(post: dict) -> dict:
    url = post.get("canonical_url") or f"{BASE}/p/{post['slug']}"
    slug = post.get("slug") or slugify(post.get("title", "post"))
    html_path = OUT_DIR / f"{slug}.html"
    txt_path = OUT_DIR / f"{slug}.txt"
    meta_path = OUT_DIR / f"{slug}.json"

    if html_path.exists() and txt_path.exists() and meta_path.exists():
        print(f"  skip (already saved): {slug}")
        return {"slug": slug, "url": url, "title": post.get("title"), "status": "cached"}

    resp = fetch_with_retry(url)
    html = resp.text
    title, text = extract_article(html)

    html_path.write_text(html, encoding="utf-8")
    txt_path.write_text(
        f"Title: {title or post.get('title', '')}\n"
        f"URL: {url}\n"
        f"Published: {post.get('post_date', '')}\n"
        f"{'=' * 72}\n\n{text}\n",
        encoding="utf-8",
    )
    meta_path.write_text(
        json.dumps(
            {
                "id": post.get("id"),
                "slug": slug,
                "title": post.get("title"),
                "subtitle": post.get("subtitle"),
                "canonical_url": url,
                "post_date": post.get("post_date"),
                "type": post.get("type"),
                "audience": post.get("audience"),
                "word_count": post.get("wordcount"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"  saved: {slug} ({len(text)} chars)")
    return {"slug": slug, "url": url, "title": post.get("title"), "status": "downloaded"}


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Enumerating archive for {BASE} ...")
    posts = list_all_posts()
    print(f"Total posts discovered: {len(posts)}")

    results = []
    for i, post in enumerate(posts, 1):
        print(f"[{i}/{len(posts)}] {post.get('title', '(untitled)')}")
        try:
            results.append(download_post(post))
        except Exception as exc:
            print(f"  ERROR: {exc}")
            results.append(
                {
                    "slug": post.get("slug"),
                    "url": post.get("canonical_url"),
                    "title": post.get("title"),
                    "status": f"error: {exc}",
                }
            )
        time.sleep(0.5)

    INDEX_PATH.write_text(json.dumps(results, indent=2), encoding="utf-8")
    downloaded = sum(1 for r in results if r["status"] == "downloaded")
    cached = sum(1 for r in results if r["status"] == "cached")
    errors = sum(1 for r in results if r["status"].startswith("error"))
    print(f"Done. downloaded={downloaded} cached={cached} errors={errors} total={len(results)}")
    return 0 if errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
