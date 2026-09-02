#!/usr/bin/env python3
"""Create a manifest for a new public conference schedule."""

from __future__ import annotations

import argparse
import json
import sys

from sync_schedule import manifest_path, validate_event_slug, write_json


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--slug", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--city", required=True)
    parser.add_argument("--timezone", default="UTC")
    parser.add_argument("--official-url", action="append", required=True)
    parser.add_argument("--keyword", action="append", default=[])
    args = parser.parse_args()
    try:
        slug = validate_event_slug(args.slug)
    except ValueError as error:
        parser.error(str(error))
    path = manifest_path(slug)
    if path.exists():
        parser.error(f"manifest already exists: {path}")
    manifest = {
        "schema_version": 1,
        "slug": slug,
        "display_name": args.name,
        "official_urls": args.official_url,
        "keywords": args.keyword,
        "event_window": {
            "start": args.start_date,
            "end": args.end_date,
            "city": args.city,
            "timezone": args.timezone,
        },
        "sources": [{
            "id": "official-page",
            "source_type": "web_page",
            "url": args.official_url[0],
            "source_url": args.official_url[0],
            "source_name": "Official event page; candidate schedule discovery",
        }],
    }
    write_json(path, manifest)
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
