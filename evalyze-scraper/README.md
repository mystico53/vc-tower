# evalyze-scraper

Scrapes every post from https://evalyze.substack.com via Substack's public archive
API, then downloads each post page and extracts a plain-text version.

## Run

```bash
cd evalyze-scraper
pip install requests beautifulsoup4
python3 scrape.py
```

Outputs:

- `articles/<slug>.html` — raw post HTML
- `articles/<slug>.txt`  — extracted plain text
- `articles/<slug>.json` — post metadata (title, date, url, word count)
- `index.json`           — summary of every post processed

The script skips any slug already present in `articles/`, so re-running only
fetches new posts. It retries transient errors with exponential backoff and
loops the archive endpoint until it returns no new posts.
