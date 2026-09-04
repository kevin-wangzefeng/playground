# Conference Schedule Explorer

This repository keeps public conference schedules in isolated event workspaces. Every event has its own manifest, raw snapshots, normalized JSONL, SQLite database, discovery candidates, and browser data. Switching events in the local browser never triggers a new fetch.

## What it collects

- KubeCon + CloudNativeCon + OpenInfra Summit + PyTorch Conference China sessions from public Sessionize APIs.
- AGNTCon + MCPCon China and official sponsor/community co-located sessions.
- Any additional event whose confirmed sources are added to its own manifest.

The importer records an activity-level fallback when a source has no session-level agenda. For conference sessions it uses the session detail URL; otherwise it falls back to the most specific available activity URL. It also preserves speaker names, normalized company names, raw affiliations, titles, biographies, profile images, and profile links when the source provides them.

## Run

```bash
python3 scripts/sync_schedule.py --event kubecon-china-2026
```

Useful options:

```bash
python3 scripts/sync_schedule.py --event kubecon-china-2026 --source kubecon-sessionize
python3 scripts/sync_schedule.py --event kubecon-china-2026 --no-snapshots
```

Each event is isolated by slug:

- `manifests/<event-slug>/event.json` — reviewed event metadata, keywords, official links, and confirmed sources.
- `data/<event-slug>/raw/` — timestamped source responses and fetch metadata.
- `data/<event-slug>/normalized/` — portable event, session, and speaker records.
- `data/<event-slug>/schedule.sqlite` — queryable canonical database.
- `data/<event-slug>/changes/` and `data/<event-slug>/discovery/` — changes and unconfirmed candidate links.
- `web/public/data/events/<event-slug>/schedule.json` — static data consumed by the browser.

## Add a new event

Create a manifest with an official event page and discovery keywords:

```bash
python3 scripts/init_event.py \
  --slug exampleconf-2027 \
  --name "ExampleConf 2027" \
  --start-date 2027-03-10 --end-date 2027-03-12 \
  --city Berlin --timezone Europe/Berlin \
  --official-url https://example.org/program \
  --keyword kubernetes --keyword cloud-native
```

The initial `web_page` source creates an activity-level fallback and writes candidate schedule links under `data/<event-slug>/discovery/`. Review a candidate before adding it to `sources` in the manifest. `sessionize_api` sources provide complete session- and speaker-level data; a generic web page does not promise a complete agenda.

## Local Schedule Explorer

The local web interface filters by event, track, company, location, meeting room, date, and topic. Its full-text search also covers session titles, descriptions, speaker companies, titles, affiliations, and biographies.

First refresh an event, then start the local development server:

```bash
python3 scripts/sync_schedule.py --event kubecon-china-2026
cd web
npm install
npm run dev
```

Open the local URL printed by the server (normally `http://localhost:3000`). Each imported event has a stable path such as `/kubecon-china-2026/`; selecting an event from the Event menu updates the browser to that path. The browser only loads pre-generated static data and never starts a crawl or a refresh.

## Netlify deployment

The browser is a static site. Netlify publishes only the generated frontend and
the reviewed files in `web/public/data/events/`; it never runs the schedule
importer or deploys raw snapshots and SQLite databases.

Connect the GitHub repository in Netlify and set the Base directory to this
project directory (`03-community-event/2026.09-kubecon-china/full-event-schedule`).
The committed `netlify.toml` then builds from `web/` and publishes `web/out/`.
Pushes to the production branch publish the public site, while pull requests can
use Netlify Deploy Previews.

To publish refreshed agenda data, run the importer locally, review the changes,
commit the updated `web/public/data/events/` JSON with the source changes, and
push. Do not add the generated `out/` directory to Git.

## License and source content

The original software and documentation in this repository are licensed under
[Apache-2.0](LICENSE). Imported schedule data is **not** relicensed: session
titles, descriptions, speaker information, images, logos, trademarks, and raw
source snapshots remain subject to the terms and rights of their original
owners. See [NOTICE](NOTICE) for the exact scope and attribution policy.
