#!/usr/bin/env python3
"""Fetch public conference schedules into event-isolated, auditable local data."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


ROOT = Path(__file__).resolve().parents[1]
MANIFESTS_DIR = ROOT / "manifests"
DATA_DIR = ROOT / "data"
WEB_EVENTS_DIR = ROOT / "web" / "public" / "data" / "events"
WEB_INDEX_PATH = WEB_EVENTS_DIR / "index.json"


def validate_event_slug(value: str) -> str:
    if not value or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in value):
        raise ValueError("event slug must contain only lowercase letters, numbers, and hyphens")
    return value


def manifest_path(event_slug: str) -> Path:
    return MANIFESTS_DIR / validate_event_slug(event_slug) / "event.json"


def event_paths(event_slug: str) -> dict[str, Path]:
    event_dir = DATA_DIR / validate_event_slug(event_slug)
    return {
        "root": event_dir,
        "raw": event_dir / "raw",
        "normalized": event_dir / "normalized",
        "discovery": event_dir / "discovery",
        "changes": event_dir / "changes",
        "database": event_dir / "schedule.sqlite",
        "web_data": WEB_EVENTS_DIR / event_slug / "schedule.json",
    }


def load_manifest(event_slug: str) -> dict[str, Any]:
    path = manifest_path(event_slug)
    if not path.exists():
        raise ValueError(f"unknown event: {event_slug}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("slug") != event_slug or not manifest.get("display_name"):
        raise ValueError(f"invalid manifest: {path}")
    window = manifest.get("event_window", {})
    if not all(window.get(field) for field in ("start", "end", "city", "timezone")):
        raise ValueError(f"manifest is missing event_window fields: {path}")
    try:
        dt.date.fromisoformat(window["start"])
        dt.date.fromisoformat(window["end"])
        ZoneInfo(window["timezone"])
    except (ValueError, ZoneInfoNotFoundError) as error:
        raise ValueError(f"manifest has invalid dates or timezone: {path}") from error
    source_ids = [source.get("id") for source in manifest.get("sources", [])]
    if len(source_ids) != len(set(source_ids)) or not all(source_ids):
        raise ValueError(f"manifest contains missing or duplicate source ids: {path}")
    unsupported = {source.get("source_type") for source in manifest.get("sources", [])} - {"sessionize_api", "web_page"}
    if unsupported:
        raise ValueError(f"unsupported source type(s): {', '.join(sorted(unsupported))}")
    if any(not source.get("url") for source in manifest.get("sources", [])):
        raise ValueError(f"manifest source is missing url: {path}")
    if any(source.get("source_type") == "sessionize_api" and not source.get("detail_base_url") for source in manifest.get("sources", [])):
        raise ValueError(f"sessionize source is missing detail_base_url: {path}")
    return manifest


def materialize_sources(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    window = manifest.get("event_window", {})
    defaults = {
        "event_name": manifest["display_name"],
        "conference_name": manifest["display_name"],
        "start_date": window.get("start"),
        "end_date": window.get("end"),
        "location": window.get("location") or window.get("city"),
        "timezone": window.get("timezone", "UTC"),
        "source_name": "Manifest-defined public schedule source",
    }
    return [{**defaults, **source} for source in manifest.get("sources", [])]


class LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[dict[str, str]] = []
        self._href: str | None = None
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            attrs_map = dict(attrs)
            self._href = attrs_map.get("href")
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._href:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._href:
            self.links.append({"url": self._href, "anchor_text": " ".join("".join(self._parts).split())})
            self._href = None
            self._parts = []


def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as file:
        for record in records:
            file.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def fetch(url: str) -> tuple[bytes, dict[str, str]]:
    request = Request(url, headers={"User-Agent": "kubecon-china-schedule-importer/1.0"})
    try:
        with build_opener().open(request, timeout=45) as response:
            return response.read(), {key.lower(): value for key, value in response.headers.items()}
    except (HTTPError, URLError) as error:
        try:
            result = subprocess.run(
                [
                    "curl", "--fail", "--location", "--silent", "--show-error",
                    "--retry", "3", "--retry-all-errors", "--connect-timeout", "20",
                    "--max-time", "60", "--user-agent", "kubecon-china-schedule-importer/1.0", url,
                ],
                check=True,
                capture_output=True,
            )
        except (FileNotFoundError, subprocess.CalledProcessError) as fallback_error:
            raise RuntimeError(f"fetch failed for {url}: {error}") from fallback_error
        return result.stdout, {"fetch-fallback": "curl", "urllib-error": str(error)}


def extract_track_colors(body: bytes) -> dict[str, str]:
    document = body.decode("utf-8", errors="replace")
    match = re.search(r'data-sched-config="([^"]+)"', document)
    if not match:
        return {}
    try:
        config = json.loads(html.unescape(match.group(1)))
    except json.JSONDecodeError:
        return {}
    colors = config.get("primaryColorOverrides", {})
    return {
        str(track): str(color)
        for track, color in colors.items()
        if isinstance(track, str) and isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color)
    }


def category_maps(schedule: dict[str, Any]) -> tuple[dict[int, str], dict[int, str], dict[int, dict[str, Any]]]:
    categories = {item["id"]: item for item in schedule.get("categories", [])}
    category_item_to_name: dict[int, str] = {}
    category_item_to_category: dict[int, str] = {}
    for category in categories.values():
        for item in category.get("items", []):
            category_item_to_name[item["id"]] = item["name"]
            category_item_to_category[item["id"]] = category["title"]
    return category_item_to_name, category_item_to_category, categories


def is_level_category(category: str | None) -> bool:
    return bool(category and "level" in category.casefold())


def choose_track(category_item_ids: list[int], item_names: dict[int, str], item_categories: dict[int, str]) -> str:
    ignored_categories = {"Session Format", "PLT Project", "Lightning Talk Topic", "Tutorial Track"}
    for item_id in category_item_ids:
        category = item_categories.get(item_id)
        if category not in ignored_categories and not is_level_category(category):
            return item_names[item_id]
    return "main track"


def choose_level(category_item_ids: list[int], item_names: dict[int, str], item_categories: dict[int, str]) -> str | None:
    return next(
        (item_names[item_id] for item_id in category_item_ids if is_level_category(item_categories.get(item_id))),
        None,
    )


def speaker_answer(speaker: dict[str, Any], question_ids: set[int]) -> str | None:
    for answer in speaker.get("questionAnswers", []):
        if answer.get("questionId") in question_ids and answer.get("answerValue"):
            return answer["answerValue"].strip()
    return None


def normalize_sessionize(source: dict[str, Any], schedule: dict[str, Any], captured_at: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    item_names, item_categories, _ = category_maps(schedule)
    rooms = {room["id"]: room.get("name") for room in schedule.get("rooms", [])}
    speakers = {speaker["id"]: speaker for speaker in schedule.get("speakers", [])}
    company_question_ids = {question["id"] for question in schedule.get("questions", []) if question.get("question", "").casefold() == "company"}
    title_question_ids = {question["id"] for question in schedule.get("questions", []) if question.get("question", "").casefold() == "speaker title"}
    speaker_records = {
        speaker_id: {
            "speaker_id": f"{source['id']}:{speaker_id}",
            "source_speaker_id": speaker_id,
            "source_id": source["id"],
            "full_name": speaker.get("fullName"),
            "company": speaker_answer(speaker, company_question_ids) or speaker.get("tagLine"),
            "speaker_title": speaker_answer(speaker, title_question_ids),
            "affiliation_raw": speaker.get("tagLine"),
            "bio": speaker.get("bio"),
            "profile_picture": speaker.get("profilePicture"),
            "links": speaker.get("links", []),
            "captured_at": captured_at,
        }
        for speaker_id, speaker in speakers.items()
    }
    events: dict[str, dict[str, Any]] = {}
    sessions: list[dict[str, Any]] = []
    for raw in schedule.get("sessions", []):
        starts_at = raw.get("startsAt")
        date = starts_at[:10] if starts_at else None
        event_id = source["id"]
        events[event_id] = {
            "event_id": event_id,
            "event_name": source["event_name"],
            "conference_name": source["conference_name"],
            "event_type": source.get("event_type", "conference"),
            "organizer": source.get("organizer"),
            "organizer_type": source.get("organizer_type"),
            "relationship_strength": source.get("relationship_strength"),
            "start_date": source.get("start_date"),
            "end_date": source.get("end_date"),
            "location": source.get("location"),
            "timezone": source["timezone"],
            "detail_url": source.get("schedule_url", source.get("source_url", source["detail_base_url"])),
            "source_url": source.get("source_url", source["url"]),
            "source_name": source["source_name"],
            "captured_at": captured_at,
            "record_status": "confirmed"
        }
        session_speakers = [speakers[speaker_id] for speaker_id in raw.get("speakers", []) if speaker_id in speakers]
        session_speaker_ids = [f"{source['id']}:{speaker['id']}" for speaker in session_speakers]
        speaker_names = [speaker.get("fullName") for speaker in session_speakers]
        speaker_companies = [speaker.get("tagLine") for speaker in session_speakers]
        companies = list(dict.fromkeys(speaker_records[speaker["id"]]["company"] for speaker in session_speakers if speaker_records[speaker["id"]]["company"]))
        category_ids = raw.get("categoryItems", [])
        tags = [item_names[item_id] for item_id in category_ids if item_id in item_names]
        detail_url = source.get("detail_url_template", "{detail_base_url}/session/{session_id}").format(
            detail_base_url=source["detail_base_url"], session_id=raw["id"]
        )
        track_name = choose_track(category_ids, item_names, item_categories)
        sessions.append({
            "session_id": f"{source['id']}:{raw['id']}",
            "source_session_id": str(raw["id"]),
            "event_id": event_id,
            "event_name": source["event_name"],
            "conference_name": source["conference_name"],
            "track_name": track_name,
            "track_color": source.get("track_colors", {}).get(track_name),
            "level": choose_level(category_ids, item_names, item_categories),
            "session_type": next((item_names[item_id] for item_id in category_ids if item_categories.get(item_id) == "Session Format"), None),
            "date": date,
            "start_time": starts_at,
            "end_time": raw.get("endsAt"),
            "timezone": source["timezone"],
            "title_original": raw.get("title"),
            "title_zh_assist": None,
            "abstract_original": raw.get("description"),
            "abstract_zh_assist": None,
            "room": rooms.get(raw.get("roomId")),
            "speaker_ids": session_speaker_ids,
            "speakers": speaker_names,
            "companies": companies,
            "speaker_companies": speaker_companies,
            "topics": tags,
            "detail_url": detail_url,
            "source_url": source.get("source_url", source["url"]),
            "link_level": "session",
            "link_note": None,
            "record_status": raw.get("status"),
            "captured_at": captured_at
        })
    return list(events.values()), sessions, list(speaker_records.values())


def deduplicate_sessions(sessions: list[dict[str, Any]], sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the highest-priority copy of explicitly configured duplicate Sessionize sessions."""
    priorities = {
        source["id"]: source["session_deduplication_priority"]
        for source in sources
        if "session_deduplication_priority" in source
    }
    grouped: dict[str, list[dict[str, Any]]] = {}
    for session in sessions:
        if session["event_id"] not in priorities:
            continue
        grouped.setdefault(session["source_session_id"], []).append(session)

    discarded_ids: set[str] = set()
    for copies in grouped.values():
        if len(copies) < 2:
            continue
        highest_priority = max(priorities[copy["event_id"]] for copy in copies)
        winners = [copy for copy in copies if priorities[copy["event_id"]] == highest_priority]
        # Equal priority means the manifest has not expressed a safe preference.
        if len(winners) == 1:
            discarded_ids.update(copy["session_id"] for copy in copies if copy is not winners[0])
    return [session for session in sessions if session["session_id"] not in discarded_ids]


def normalize_web_page(source: dict[str, Any], captured_at: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    event = {
        "event_id": source["id"],
        "event_name": source["event_name"],
        "conference_name": source["conference_name"],
        "event_type": "community_or_colocated",
        "organizer": source.get("organizer"),
        "organizer_type": source.get("organizer_type"),
        "relationship_strength": source.get("relationship_strength"),
        "start_date": source.get("start_date"),
        "end_date": source.get("end_date"),
        "location": source.get("location"),
        "timezone": source["timezone"],
        "detail_url": source["url"],
        "source_url": source["url"],
        "source_name": source["source_name"],
        "captured_at": captured_at,
        "record_status": "needs_session_discovery"
    }
    session = {
        "session_id": f"{source['id']}:activity",
        "event_id": source["id"],
        "event_name": source["event_name"],
        "conference_name": source["conference_name"],
        "track_name": source.get("track_name", "main track"),
        "level": None,
        "session_type": "activity",
        "date": source.get("start_date"),
        "start_time": None,
        "end_time": None,
        "timezone": source["timezone"],
        "title_original": source["event_name"],
        "title_zh_assist": None,
        "abstract_original": None,
        "abstract_zh_assist": None,
        "room": source.get("location"),
        "speakers": [],
        "speaker_companies": [],
        "topics": [],
        "detail_url": source["url"],
        "source_url": source["url"],
        "link_level": "activity",
        "link_note": "No session-level public schedule configured yet.",
        "record_status": "needs_session_discovery",
        "captured_at": captured_at
    }
    return [event], [session], []


def initialize_database(connection: sqlite3.Connection) -> None:
    connection.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS speakers (
      speaker_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      source_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      response_metadata TEXT NOT NULL
    );
    """)


def record_content_hash(record: dict[str, Any]) -> str:
    stable_record = {field: value for field, value in record.items() if field != "captured_at"}
    payload = json.dumps(stable_record, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def upsert_records(connection: sqlite3.Connection, table: str, records: list[dict[str, Any]], key: str, source_ids: set[str]) -> dict[str, int]:
    existing = {row[0]: row[1] for row in connection.execute(f"SELECT {key}, content_hash FROM {table}")}
    current_ids = {record[key] for record in records}
    if table == "events":
        scoped_existing_ids = {record_id for record_id in existing if record_id in source_ids}
    else:
        scoped_existing_ids = {record_id for record_id in existing if any(record_id.startswith(f"{source_id}:") for source_id in source_ids)}
    inserted = updated = 0
    for record in records:
        payload = json.dumps(record, ensure_ascii=False, sort_keys=True)
        content_hash = record_content_hash(record)
        if record[key] not in existing:
            inserted += 1
        elif existing[record[key]] != content_hash:
            updated += 1
        if table == "events":
            connection.execute("INSERT INTO events VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO UPDATE SET payload=excluded.payload, content_hash=excluded.content_hash, captured_at=excluded.captured_at", (record[key], payload, content_hash, record["captured_at"]))
        elif table == "sessions":
            connection.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET event_id=excluded.event_id, payload=excluded.payload, content_hash=excluded.content_hash, captured_at=excluded.captured_at", (record[key], record["event_id"], payload, content_hash, record["captured_at"]))
        else:
            connection.execute("INSERT INTO speakers VALUES (?, ?, ?, ?) ON CONFLICT(speaker_id) DO UPDATE SET payload=excluded.payload, content_hash=excluded.content_hash, captured_at=excluded.captured_at", (record[key], payload, content_hash, record["captured_at"]))
    removed_ids = scoped_existing_ids - current_ids
    if removed_ids:
        placeholders = ", ".join("?" for _ in removed_ids)
        connection.execute(f"DELETE FROM {table} WHERE {key} IN ({placeholders})", tuple(sorted(removed_ids)))
    return {"inserted": inserted, "updated": updated, "removed": len(removed_ids)}


def load_records(connection: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    return [json.loads(row[0]) for row in connection.execute(f"SELECT payload FROM {table} ORDER BY 1")]


def write_web_data(path: Path, events: list[dict[str, Any]], sessions: list[dict[str, Any]], speakers: list[dict[str, Any]]) -> None:
    event_locations = {event["event_id"]: event.get("location") for event in events}
    web_sessions = []
    for session in sessions:
        web_sessions.append({
            **session,
            "title": session.get("title_original") or "Untitled session",
            "description": session.get("abstract_original"),
            "starts_at": session.get("start_time"),
            "ends_at": session.get("end_time"),
            "meeting_room": session.get("room"),
            "location": event_locations.get(session["event_id"]),
        })
    write_json(path, {"captured_at": now_utc(), "events": events, "sessions": web_sessions, "speakers": speakers})


def write_event_index() -> None:
    events: list[dict[str, Any]] = []
    for path in sorted(MANIFESTS_DIR.glob("*/event.json")):
        manifest = json.loads(path.read_text(encoding="utf-8"))
        slug = manifest.get("slug")
        if not slug or not event_paths(slug)["web_data"].exists():
            continue
        window = manifest.get("event_window", {})
        events.append({
            "slug": slug,
            "display_name": manifest.get("display_name", slug),
            "location": window.get("location") or window.get("city"),
            "start_date": window.get("start"),
            "end_date": window.get("end"),
            "timezone": window.get("timezone", "UTC"),
            "default": bool(manifest.get("default")),
            "data_url": f"/data/events/{slug}/schedule.json",
        })
    events.sort(key=lambda event: (not event["default"], event["start_date"] or "", event["slug"]))
    write_json(WEB_INDEX_PATH, {"generated_at": now_utc(), "events": events})


def discover_links(source: dict[str, Any], body: bytes, captured_at: str, keywords: list[str]) -> list[dict[str, Any]]:
    parser = LinkParser()
    parser.feed(body.decode("utf-8", errors="replace"))
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for link in parser.links:
        url = html.unescape(link["url"])
        haystack = f"{url} {link['anchor_text']}".lower()
        if url in seen or not url.startswith(("http://", "https://")):
            continue
        tokens = ("schedule", "agenda", "program", "register", "meetup", "con", "summit", "open source", "mcp", "agent", *[keyword.casefold() for keyword in keywords])
        if any(token in haystack for token in tokens):
            candidates.append({"discovered_from": source["id"], "url": url, "anchor_text": link["anchor_text"], "captured_at": captured_at})
            seen.add(url)
    return candidates


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--event", required=True, help="event slug under manifests/")
    parser.add_argument("--source", action="append", help="source id to fetch; repeatable")
    parser.add_argument("--no-snapshots", action="store_true")
    args = parser.parse_args()
    try:
        manifest = load_manifest(args.event)
    except ValueError as error:
        parser.error(str(error))
    paths = event_paths(args.event)
    sources = materialize_sources(manifest)
    selected = [source for source in sources if not args.source or source["id"] in args.source]
    missing = set(args.source or []) - {source["id"] for source in selected}
    if missing:
        parser.error(f"unknown source id(s): {', '.join(sorted(missing))}")
    captured_at = now_utc()
    all_events: list[dict[str, Any]] = []
    all_sessions: list[dict[str, Any]] = []
    all_speakers: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    source_results: list[dict[str, Any]] = []
    for source in selected:
        body, headers = fetch(source["url"])
        if source.get("style_source_url"):
            style_body, _ = fetch(source["style_source_url"])
            source["track_colors"] = extract_track_colors(style_body)
        content_hash = sha256_bytes(body)
        source_results.append({"source_id": source["id"], "url": source["url"], "content_hash": content_hash, "captured_at": captured_at, "response_metadata": headers})
        if not args.no_snapshots:
            suffix = "json" if source["source_type"] == "sessionize_api" else "html"
            snapshot_path = paths["raw"] / source["id"] / f"{captured_at.replace(':', '').replace('+', '_')}.{suffix}"
            snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            snapshot_path.write_bytes(body)
            write_json(snapshot_path.with_suffix(snapshot_path.suffix + ".metadata.json"), {"source": source, "headers": headers, "content_hash": content_hash, "captured_at": captured_at})
        if source["source_type"] == "sessionize_api":
            events, sessions, speakers = normalize_sessionize(source, json.loads(body), captured_at)
        else:
            events, sessions, speakers = normalize_web_page(source, captured_at)
            candidates.extend(discover_links(source, body, captured_at, manifest.get("keywords", [])))
        all_events.extend(events)
        all_sessions.extend(sessions)
        all_speakers.extend(speakers)
    all_sessions = deduplicate_sessions(all_sessions, selected)
    connection = sqlite3.connect(paths["database"])
    try:
        initialize_database(connection)
        source_ids = {source["id"] for source in selected}
        event_changes = upsert_records(connection, "events", all_events, "event_id", source_ids)
        session_changes = upsert_records(connection, "sessions", all_sessions, "session_id", source_ids)
        speaker_changes = upsert_records(connection, "speakers", all_speakers, "speaker_id", source_ids)
        for result in source_results:
            connection.execute("INSERT INTO sources VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET url=excluded.url, content_hash=excluded.content_hash, captured_at=excluded.captured_at, response_metadata=excluded.response_metadata", (result["source_id"], result["url"], result["content_hash"], result["captured_at"], json.dumps(result["response_metadata"], sort_keys=True)))
        connection.commit()
        persisted_events = load_records(connection, "events")
        persisted_sessions = load_records(connection, "sessions")
        persisted_speakers = load_records(connection, "speakers")
    finally:
        connection.close()
    write_jsonl(paths["normalized"] / "events.jsonl", persisted_events)
    write_jsonl(paths["normalized"] / "sessions.jsonl", persisted_sessions)
    write_jsonl(paths["normalized"] / "speakers.jsonl", persisted_speakers)
    write_web_data(paths["web_data"], persisted_events, persisted_sessions, persisted_speakers)
    write_event_index()
    write_jsonl(paths["discovery"] / "candidates.jsonl", candidates)
    changes = {"captured_at": captured_at, "events": event_changes, "sessions": session_changes, "speakers": speaker_changes, "sources_fetched": [source["id"] for source in selected], "discovery_candidates": len(candidates)}
    write_json(paths["changes"] / "latest.json", changes)
    print(json.dumps(changes, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
