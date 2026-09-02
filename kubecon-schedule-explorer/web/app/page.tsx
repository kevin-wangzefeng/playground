"use client";
/* eslint-disable @next/next/no-img-element */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

type Speaker = {
  speaker_id: string;
  full_name: string;
  company?: string | null;
  speaker_title?: string | null;
  affiliation_raw?: string | null;
  bio?: string | null;
  profile_picture?: string | null;
  links?: { title?: string; url?: string }[];
};
type EventRecord = {
  event_id: string;
  event_name: string;
  location?: string | null;
};
type Session = {
  session_id: string;
  title?: string | null;
  title_original?: string | null;
  description?: string | null;
  abstract_original?: string | null;
  event_id: string;
  event_name: string;
  track_name?: string | null;
  track_color?: string | null;
  level?: string | null;
  location?: string | null;
  meeting_room?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  room?: string | null;
  detail_url?: string | null;
  session_type?: string | null;
  topics?: string[];
  speaker_ids?: string[];
  companies?: string[];
  date?: string | null;
};
type ScheduleData = {
  captured_at: string;
  generated_at?: string;
  events: EventRecord[];
  sessions: Session[];
  speakers: Speaker[];
};
type EventSummary = {
  slug: string;
  display_name: string;
  location?: string | null;
  timezone?: string | null;
  default?: boolean;
  data_url: string;
};
type Filters = Record<string, Set<string>>;
type View = "list" | "calendar";
type CalendarMode = "rooms" | "tracks";
type CalendarDensity = "standard" | "tall";
type LaneSession = { session: Session; lane: number; laneCount: number };
type ListWidths = { filters: number; details: number };
type TimeWindow = { start: number; end: number };
type TimeWindowDrag = {
  mode: "start" | "end" | "move";
  start: number;
  end: number;
  minute: number;
};
type CalendarRangeSelection = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

const dimensions = [
  ["event_name", "Event"],
  ["track_name", "Track"],
  ["level", "Level"],
  ["companies", "Company"],
  ["location", "Location"],
  ["meeting_room", "Meeting room"],
  ["date", "Date"],
  ["topics", "Topic"],
] as const;
const searchableFilterDimensions = new Set([
  "track_name",
  "companies",
  "topics",
]);
const SPECIAL_TRACK =
  /registration|badge|meal|break|network|showcase|sponsor-hosted|foyer/i;
const LEVEL_TAG = /^(?:any|beginner|intermediate|medium|advanced)$/i;
const TIME_WINDOW_STEP = 15;
const MIN_TIME_WINDOW = 30;
const timestampHasOffset = (value: string) =>
  /(?:Z|[+-]\d\d:\d\d)$/i.test(value);
const isPanel = (session: Session) => (session.speaker_ids?.length ?? 0) > 3;
const isSpecialTrack = (session: Session) =>
  SPECIAL_TRACK.test(session.track_name ?? "");
function calendarTrackName(session: Session) {
  const sourceTrack = session.track_name?.trim();
  if (sourceTrack && !LEVEL_TAG.test(sourceTrack)) return sourceTrack;
  return (
    session.topics
      ?.map((topic) => topic.trim())
      .find((topic) => topic && !LEVEL_TAG.test(topic)) ?? "Main track"
  );
}
const calendarTags = (session: Session) =>
  [
    calendarTrackName(session),
    session.level,
    session.session_type,
    ...(session.topics ?? []),
  ].filter(
    (value, index, values): value is string =>
      Boolean(value?.trim()) && values.indexOf(value) === index,
  );

function dateText(value?: string | null, timezone = "UTC") {
  if (!value) return "Time TBA";
  if (!timestampHasOffset(value)) {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    return new Intl.DateTimeFormat("en-GB", {
      month: "short",
      day: "numeric",
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    weekday: "short",
    timeZone: timezone,
  }).format(new Date(value));
}
function timeText(value?: string | null, timezone = "UTC") {
  if (!value) return "TBA";
  if (!timestampHasOffset(value)) return value.slice(11, 16);
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(new Date(value));
}
function minuteOfDay(value?: string | null) {
  if (!value) return 0;
  const [hour, minute] = value.slice(11, 16).split(":").map(Number);
  return hour * 60 + minute;
}
function minuteLabel(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
    minute % 60,
  ).padStart(2, "0")}`;
}
function googleCalendarDateTime(value?: string | null, timezone = "UTC") {
  if (!value) return null;
  if (!timestampHasOffset(value)) {
    const localValue = value.slice(0, 16);
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localValue)
      ? `${localValue.replace(/[-:]/g, "")}00`
      : null;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value;
    const [year, month, day, hour, minute] = [
      part("year"),
      part("month"),
      part("day"),
      part("hour"),
      part("minute"),
    ];
    return year && month && day && hour && minute
      ? `${year}${month}${day}T${hour}${minute}00`
      : null;
  } catch {
    return null;
  }
}
function googleCalendarTemplateUrl(
  session: Session,
  timezone: string,
  speakerMap: Map<string, Speaker>,
) {
  const start = googleCalendarDateTime(session.starts_at, timezone);
  const end = googleCalendarDateTime(session.ends_at, timezone);
  if (!start || !end) return null;
  const speakers = (session.speaker_ids ?? [])
    .map((id) => speakerMap.get(id))
    .filter(Boolean) as Speaker[];
  const details = [
    session.description,
    `Event: ${session.event_name}`,
    `Track: ${session.track_name || "Main track"}`,
    session.level ? `Level: ${session.level}` : null,
    speakers.length
      ? `Speakers: ${speakers
          .map((speaker) =>
            [speaker.full_name, speaker.company || speaker.affiliation_raw]
              .filter(Boolean)
              .join(" · "),
          )
          .join("; ")}`
      : null,
    session.detail_url ? `Session details: ${session.detail_url}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: session.title || "Untitled session",
    dates: `${start}/${end}`,
    ctz: timezone,
    details,
  });
  const location = [session.location, session.meeting_room]
    .filter(Boolean)
    .join(" · ");
  if (location) params.set("location", location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
function snapMinute(minute: number) {
  return Math.round(minute / TIME_WINDOW_STEP) * TIME_WINDOW_STEP;
}
function valueFor(session: Session, dimension: string) {
  if (dimension === "date") return session.date ? [session.date] : [];
  const value = session[dimension as keyof Session];
  return Array.isArray(value)
    ? value.filter(Boolean)
    : value
      ? [String(value)]
      : [];
}
function normalizeScheduleData(input: ScheduleData): ScheduleData {
  const locations = new Map(
    input.events.map((event) => [event.event_id, event.location]),
  );
  return {
    ...input,
    captured_at: input.captured_at || input.generated_at || "",
    sessions: input.sessions.map((session) => ({
      ...session,
      title: session.title || session.title_original || "Untitled session",
      description: session.description ?? session.abstract_original,
      starts_at: session.starts_at || session.start_time,
      ends_at: session.ends_at || session.end_time,
      meeting_room: session.meeting_room || session.room,
      location: session.location || locations.get(session.event_id) || null,
      date:
        session.date ||
        session.starts_at?.slice(0, 10) ||
        session.start_time?.slice(0, 10),
    })),
  };
}
function sessionSearchText(session: Session, speakerMap: Map<string, Speaker>) {
  const speakers = (session.speaker_ids ?? [])
    .map((id) => speakerMap.get(id))
    .filter(Boolean) as Speaker[];
  return [
    session.title,
    session.description,
    session.event_name,
    session.track_name,
    session.level,
    session.location,
    session.meeting_room,
    ...(session.topics ?? []),
    ...(session.companies ?? []),
    ...speakers.flatMap((speaker) => [
      speaker.full_name,
      speaker.company,
      speaker.speaker_title,
      speaker.affiliation_raw,
      speaker.bio,
    ]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}
function laneLayout(sessions: Session[]): LaneSession[] {
  const sorted = [...sessions].sort(
    (a, b) =>
      minuteOfDay(a.starts_at) - minuteOfDay(b.starts_at) ||
      minuteOfDay(a.ends_at) - minuteOfDay(b.ends_at),
  );
  const assigned: LaneSession[] = [];
  let cluster: LaneSession[] = [];
  let clusterEnd = -1;
  const finishCluster = () => {
    const count = Math.max(1, ...cluster.map((item) => item.lane + 1));
    cluster.forEach((item) => {
      item.laneCount = count;
    });
    cluster = [];
  };
  sorted.forEach((session) => {
    const start = minuteOfDay(session.starts_at);
    const end = Math.max(start + 15, minuteOfDay(session.ends_at));
    if (cluster.length && start >= clusterEnd) finishCluster();
    const occupied = cluster
      .filter((item) => minuteOfDay(item.session.ends_at) > start)
      .map((item) => item.lane);
    let lane = 0;
    while (occupied.includes(lane)) lane += 1;
    const item = { session, lane, laneCount: 1 };
    cluster.push(item);
    assigned.push(item);
    clusterEnd = Math.max(clusterEnd, end);
  });
  if (cluster.length) finishCluster();
  return assigned;
}

export function ScheduleExplorer({
  initialEventSlug,
}: {
  initialEventSlug?: string;
}) {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [eventIndex, setEventIndex] = useState<EventSummary[]>([]);
  const [eventSlug, setEventSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>({});
  const [optionQueries, setOptionQueries] = useState<Record<string, string>>(
    {},
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>("track_name");
  const [view, setView] = useState<View>("list");
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("rooms");
  const [calendarDensity, setCalendarDensity] =
    useState<CalendarDensity>("standard");
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const [timeWindows, setTimeWindows] = useState<Record<string, TimeWindow>>(
    {},
  );
  const [timeWindowDrag, setTimeWindowDrag] = useState<TimeWindowDrag | null>(
    null,
  );
  const timeWindowTrackRef = useRef<HTMLDivElement>(null);
  const [calendarRangeSelection, setCalendarRangeSelection] =
    useState<CalendarRangeSelection | null>(null);
  const calendarBoardRef = useRef<HTMLDivElement>(null);
  const [showSpecialTracks, setShowSpecialTracks] = useState(true);
  const [panelOnly, setPanelOnly] = useState(false);
  const [hiddenRooms, setHiddenRooms] = useState<Set<string>>(new Set());
  const [hiddenTracks, setHiddenTracks] = useState<Set<string>>(new Set());
  const [expandedRooms, setExpandedRooms] = useState<Set<string>>(new Set());
  const [expandedTracks, setExpandedTracks] = useState<Set<string>>(new Set());
  const [widths, setWidths] = useState<ListWidths>(() => {
    if (typeof window === "undefined") return { filters: 250, details: 420 };
    try {
      return JSON.parse(
        localStorage.getItem("schedule-list-widths") ??
          '{"filters":250,"details":420}',
      ) as ListWidths;
    } catch {
      return { filters: 250, details: 420 };
    }
  });

  useEffect(() => {
    fetch(`/data/events/index.json?refresh=${Date.now()}`, {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((result: { events: EventSummary[] }) => {
        setEventIndex(result.events);
        const requested = initialEventSlug;
        const selected =
          result.events.find((event) => event.slug === requested) ??
          result.events.find((event) => event.default) ??
          result.events[0];
        setEventSlug(selected?.slug ?? null);
      })
      .catch(() =>
        setData({ captured_at: "", events: [], sessions: [], speakers: [] }),
      );
  }, [initialEventSlug]);
  useEffect(() => {
    const event = eventIndex.find((item) => item.slug === eventSlug);
    if (!event) return;
    fetch(`${event.data_url}?refresh=${Date.now()}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((result: ScheduleData) => setData(normalizeScheduleData(result)))
      .catch(() =>
        setData({ captured_at: "", events: [], sessions: [], speakers: [] }),
      );
  }, [eventIndex, eventSlug]);
  useEffect(() => {
    if (!detailOpen || !window.matchMedia("(max-width: 1100px)").matches)
      return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [detailOpen]);
  useEffect(() => {
    if (!detailOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detailOpen]);

  const speakerMap = useMemo(
    () =>
      new Map(data?.speakers.map((speaker) => [speaker.speaker_id, speaker])),
    [data],
  );
  const activeEvent = eventIndex.find((event) => event.slug === eventSlug);
  const timezone = activeEvent?.timezone || "UTC";
  const choices = useMemo(
    () =>
      Object.fromEntries(
        dimensions.map(([key]) => [
          key,
          [
            ...new Set(
              (data?.sessions ?? []).flatMap((session) =>
                valueFor(session, key),
              ),
            ),
          ].sort((a, b) => a.localeCompare(b)),
        ]),
      ),
    [data],
  );
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (data?.sessions ?? [])
      .filter(
        (session) =>
          (!needle ||
            sessionSearchText(session, speakerMap).includes(needle)) &&
          (showSpecialTracks || !isSpecialTrack(session)) &&
          (!panelOnly || isPanel(session)) &&
          Object.entries(filters).every(
            ([dimension, selected]) =>
              !selected.size ||
              valueFor(session, dimension).some((value) => selected.has(value)),
          ),
      )
      .sort(
        (a, b) =>
          (a.starts_at ?? "").localeCompare(b.starts_at ?? "") ||
          String(a.title).localeCompare(String(b.title)),
      );
  }, [data, filters, panelOnly, query, showSpecialTracks, speakerMap]);
  const dates = useMemo(
    () =>
      [
        ...new Set(
          results.map((session) => session.date).filter(Boolean) as string[],
        ),
      ].sort(),
    [results],
  );
  const activeDay =
    calendarDay && dates.includes(calendarDay) ? calendarDay : dates[0];
  const selected =
    results.find((session) => session.session_id === selectedId) ?? results[0];
  const activeCount =
    Object.values(filters).reduce((total, values) => total + values.size, 0) +
    Number(!showSpecialTracks) +
    Number(panelOnly);

  function toggle(dimension: string, value: string) {
    setFilters((current) => {
      const next = new Set(current[dimension] ?? []);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...current, [dimension]: next };
    });
  }
  function selectSession(session: Session) {
    setSelectedId(session.session_id);
    setDetailOpen(true);
  }
  function hideColumn(column: string) {
    if (calendarMode === "rooms")
      setHiddenRooms((current) => new Set(current).add(column));
    else setHiddenTracks((current) => new Set(current).add(column));
  }
  function toggleColumnExpansion(column: string) {
    if (calendarMode === "rooms")
      setExpandedRooms((current) => {
        const next = new Set(current);
        if (next.has(column)) next.delete(column);
        else next.add(column);
        return next;
      });
    else
      setExpandedTracks((current) => {
        const next = new Set(current);
        if (next.has(column)) next.delete(column);
        else next.add(column);
        return next;
      });
  }
  function switchEvent(slug: string) {
    setQuery("");
    setFilters({});
    setSelectedId(null);
    setDetailOpen(false);
    setData(null);
    setEventSlug(slug);
    const url = new URL(window.location.href);
    url.pathname = `/${slug}/`;
    url.searchParams.delete("event");
    window.history.replaceState({}, "", url);
  }
  function resize(
    kind: "filters" | "details",
    event: React.PointerEvent<HTMLButtonElement>,
  ) {
    event.preventDefault();
    const startX = event.clientX;
    const start = widths[kind];
    const sign = kind === "filters" ? 1 : -1;
    let finalWidths = widths;
    const move = (pointer: PointerEvent) =>
      setWidths((current) => {
        finalWidths = {
          ...current,
          [kind]: Math.max(
            kind === "filters" ? 180 : 300,
            Math.min(
              kind === "filters" ? 420 : 700,
              start + (pointer.clientX - startX) * sign,
            ),
          ),
        };
        return finalWidths;
      });
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      localStorage.setItem("schedule-list-widths", JSON.stringify(finalWidths));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }
  function detailContent() {
    if (!selected)
      return <div className="empty">Select a session to see its details.</div>;
    const calendarUrl = googleCalendarTemplateUrl(
      selected,
      timezone,
      speakerMap,
    );
    return (
      <>
        <p className="eyebrow">{selected.event_name}</p>
        <h2>{selected.title}</h2>
        <div className="detail-facts">
          <div>
            <span>When</span>
            <strong>
              {dateText(selected.starts_at, timezone)} ·{" "}
              {timeText(selected.starts_at, timezone)}–
              {timeText(selected.ends_at, timezone)}
            </strong>
          </div>
          <div>
            <span>Where</span>
            <strong>
              {[selected.location, selected.meeting_room]
                .filter(Boolean)
                .join(" · ") || "TBA"}
            </strong>
          </div>
          <div>
            <span>Track</span>
            <strong>{selected.track_name || "Main track"}</strong>
          </div>
          {selected.level ? (
            <div>
              <span>Level</span>
              <strong>{selected.level}</strong>
            </div>
          ) : null}
        </div>
        {selected.description ? (
          <p className="description">{selected.description}</p>
        ) : null}
        {selected.topics?.length ? (
          <div className="tags">
            {selected.topics.map((topic) => (
              <span key={topic}>{topic}</span>
            ))}
          </div>
        ) : null}
        <div className="speakers">
          <h3>Speakers</h3>
          {(selected.speaker_ids ?? []).map((id) => {
            const speaker = speakerMap.get(id);
            return speaker ? (
              <article className="speaker" key={id}>
                {speaker.profile_picture ? (
                  <img src={speaker.profile_picture} alt="" />
                ) : (
                  <div className="avatar">{speaker.full_name.slice(0, 1)}</div>
                )}
                <div>
                  <strong>{speaker.full_name}</strong>
                  <p>
                    {[
                      speaker.speaker_title,
                      speaker.company || speaker.affiliation_raw,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {speaker.bio ? <p className="bio">{speaker.bio}</p> : null}
                </div>
              </article>
            ) : null;
          })}
        </div>
        {calendarUrl || selected.detail_url ? (
          <div className="detail-actions">
            {calendarUrl ? (
              <a
                className="calendar-link"
                href={calendarUrl}
                target="_blank"
                rel="noreferrer"
              >
                Add to Google Calendar ↗
              </a>
            ) : null}
            {selected.detail_url ? (
              <a
                className="official-link"
                href={selected.detail_url}
                target="_blank"
                rel="noreferrer"
              >
                Open official session page ↗
              </a>
            ) : null}
            {calendarUrl ? (
              <p className="calendar-note">
                Choose KubeConSessions in Google Calendar before saving.
              </p>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }
  function filterContent(expandAll = false) {
    return (
      <div className="filter-grid">
        {dimensions.map(([key, label]) => (
          <div className="filter-group" key={key}>
            {expandAll ? (
              <p className="filter-title">{label}</p>
            ) : (
              <button
                className="filter-title"
                onClick={() => setExpanded(expanded === key ? null : key)}
              >
                <span>{label}</span>
                <span>{expanded === key ? "−" : "+"}</span>
              </button>
            )}
            {expandAll || expanded === key ? (
              <div
                className={`filter-options ${expandAll ? "calendar-filter-options" : ""}`}
              >
                {searchableFilterDimensions.has(key) ? (
                  <input
                    className="filter-option-search"
                    value={optionQueries[key] ?? ""}
                    onChange={(event) =>
                      setOptionQueries((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                    placeholder={`Search ${label.toLowerCase()}…`}
                    aria-label={`Search ${label} filter options`}
                  />
                ) : null}
                <label>
                  <input
                    type="checkbox"
                    checked={!(filters[key]?.size ?? 0)}
                    onChange={() =>
                      setFilters((current) => ({
                        ...current,
                        [key]: new Set(),
                      }))
                    }
                  />
                  All
                </label>
                {(choices[key] ?? [])
                  .filter((value) =>
                    value
                      .toLocaleLowerCase()
                      .includes(
                        (optionQueries[key] ?? "").trim().toLocaleLowerCase(),
                      ),
                  )
                  .map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={filters[key]?.has(value) ?? false}
                        onChange={() => toggle(key, value)}
                      />
                      {value}
                    </label>
                  ))}
              </div>
            ) : null}
          </div>
        ))}
        <div className="filter-group">
          <p className="filter-title">Card categories</p>
          <div className="filter-options">
            <label>
              <input
                type="checkbox"
                checked={showSpecialTracks}
                onChange={(event) => setShowSpecialTracks(event.target.checked)}
              />
              Show special tracks
            </label>
            <label>
              <input
                type="checkbox"
                checked={panelOnly}
                onChange={(event) => setPanelOnly(event.target.checked)}
              />
              Panel only (&gt;3 speakers)
            </label>
          </div>
        </div>
      </div>
    );
  }
  if (!data) return <main className="loading">Loading schedule…</main>;

  const allDaySessions = data.sessions.filter(
    (session) => session.date === activeDay,
  );
  const fullStartMinute =
    Math.floor(
      Math.min(
        ...allDaySessions.map((session) => minuteOfDay(session.starts_at)),
        8 * 60,
      ) / 30,
    ) * 30;
  const fullEndMinute =
    Math.ceil(
      Math.max(
        ...allDaySessions.map((session) => minuteOfDay(session.ends_at)),
        18 * 60,
      ) / 30,
    ) * 30;
  const savedTimeWindow = activeDay ? timeWindows[activeDay] : undefined;
  const windowStart = Math.min(
    fullEndMinute - MIN_TIME_WINDOW,
    Math.max(fullStartMinute, savedTimeWindow?.start ?? fullStartMinute),
  );
  const windowEnd = Math.max(
    windowStart + MIN_TIME_WINDOW,
    Math.min(fullEndMinute, savedTimeWindow?.end ?? fullEndMinute),
  );
  const windowRange = windowEnd - windowStart;
  const daySessions = results.filter(
    (session) =>
      session.date === activeDay &&
      minuteOfDay(session.ends_at) > windowStart &&
      minuteOfDay(session.starts_at) < windowEnd,
  );
  const columnKey = (session: Session) =>
    calendarMode === "rooms"
      ? session.meeting_room || "Room TBA"
      : calendarTrackName(session);
  const hiddenColumns = calendarMode === "rooms" ? hiddenRooms : hiddenTracks;
  const expandedColumns =
    calendarMode === "rooms" ? expandedRooms : expandedTracks;
  const columns = [...new Set(daySessions.map(columnKey))]
    .filter((column) => !hiddenColumns.has(column))
    .sort((a, b) => a.localeCompare(b));
  const columnWidth = (column: string) => {
    if (!expandedColumns.has(column)) return 220;
    const maxParallelLanes = Math.max(
      1,
      ...laneLayout(
        daySessions.filter((session) => columnKey(session) === column),
      ).map((item) => item.laneCount),
    );
    return Math.max(420, maxParallelLanes * 220);
  };
  const fullRange = fullEndMinute - fullStartMinute;
  const densityMultiplier = calendarDensity === "tall" ? 1.8 / 1.15 : 1;
  const pixelsPerMinute =
    ((fullRange * 1.15 * densityMultiplier) / windowRange) * 1;
  const hourLabels = [
    windowStart,
    ...Array.from(
      {
        length: Math.max(
          0,
          Math.ceil(windowEnd / 60) - Math.floor(windowStart / 60),
        ),
      },
      (_, index) => (Math.floor(windowStart / 60) + index + 1) * 60,
    ).filter((minute) => minute > windowStart && minute < windowEnd),
    windowEnd,
  ].filter((minute, index, values) => values.indexOf(minute) === index);

  const setTimeWindow = (start: number, end: number) => {
    if (!activeDay) return;
    const safeStart = Math.max(
      fullStartMinute,
      Math.min(start, fullEndMinute - MIN_TIME_WINDOW),
    );
    const safeEnd = Math.min(
      fullEndMinute,
      Math.max(end, safeStart + MIN_TIME_WINDOW),
    );
    setTimeWindows((current) => ({
      ...current,
      [activeDay]: { start: safeStart, end: safeEnd },
    }));
  };
  const minuteFromPointer = (clientY: number) => {
    const bounds = timeWindowTrackRef.current?.getBoundingClientRect();
    if (!bounds) return windowStart;
    const fraction = Math.max(
      0,
      Math.min(1, (clientY - bounds.top) / bounds.height),
    );
    return snapMinute(fullStartMinute + fraction * fullRange);
  };
  const beginTimeWindowDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>("[data-time-window-handle]");
    const mode = handle?.dataset.timeWindowHandle as
      TimeWindowDrag["mode"] | undefined;
    const movingWindow = target.closest("[data-time-window-selection]");
    if (!mode && !movingWindow) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setTimeWindowDrag({
      mode: mode ?? "move",
      start: windowStart,
      end: windowEnd,
      minute: minuteFromPointer(event.clientY),
    });
  };
  const moveTimeWindow = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!timeWindowDrag) return;
    const minute = minuteFromPointer(event.clientY);
    if (timeWindowDrag.mode === "start") {
      setTimeWindow(
        Math.min(minute, timeWindowDrag.end - MIN_TIME_WINDOW),
        timeWindowDrag.end,
      );
    } else if (timeWindowDrag.mode === "end") {
      setTimeWindow(
        timeWindowDrag.start,
        Math.max(minute, timeWindowDrag.start + MIN_TIME_WINDOW),
      );
    } else {
      const duration = timeWindowDrag.end - timeWindowDrag.start;
      const start = Math.max(
        fullStartMinute,
        Math.min(
          fullEndMinute - duration,
          timeWindowDrag.start + minute - timeWindowDrag.minute,
        ),
      );
      setTimeWindow(start, start + duration);
    }
  };
  const endTimeWindowDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (timeWindowDrag)
      event.currentTarget.releasePointerCapture(event.pointerId);
    setTimeWindowDrag(null);
  };
  const calendarPointFromPointer = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const bounds = calendarBoardRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: Math.max(72, Math.min(bounds.width, event.clientX - bounds.left)),
      y: Math.max(52, Math.min(bounds.height, event.clientY - bounds.top)),
    };
  };
  const beginCalendarRangeSelection = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    const target = event.target as HTMLElement;
    if (
      event.button !== 0 ||
      target.closest("button") ||
      !target.closest(".calendar-column")
    )
      return;
    const point = calendarPointFromPointer(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setCalendarRangeSelection({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
    });
  };
  const moveCalendarRangeSelection = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!calendarRangeSelection) return;
    const point = calendarPointFromPointer(event);
    if (!point) return;
    setCalendarRangeSelection((current) =>
      current ? { ...current, currentX: point.x, currentY: point.y } : null,
    );
  };
  const endCalendarRangeSelection = (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (!calendarRangeSelection) return;
    const point = calendarPointFromPointer(event);
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (point && Math.abs(point.y - calendarRangeSelection.startY) >= 6) {
      const start = snapMinute(
        windowStart +
          (Math.min(calendarRangeSelection.startY, point.y) - 52) /
            pixelsPerMinute,
      );
      const end = snapMinute(
        windowStart +
          (Math.max(calendarRangeSelection.startY, point.y) - 52) /
            pixelsPerMinute,
      );
      setTimeWindow(start, end);
    }
    setCalendarRangeSelection(null);
  };

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">
            {activeEvent?.location || "Conference schedule"}
          </p>
          <h1>Schedule Explorer</h1>
          <p className="subtitle">
            Search, compare, and map sessions across rooms and tracks.
          </p>
        </div>
        <label className="event-picker">
          <span>Event</span>
          <select
            value={eventSlug ?? ""}
            onChange={(event) => switchEvent(event.target.value)}
          >
            {eventIndex.map((event) => (
              <option key={event.slug} value={event.slug}>
                {event.display_name}
              </option>
            ))}
          </select>
        </label>
        <div className="data-note">
          {data.sessions.length} sessions · {data.speakers.length} speakers
          <br />
          Data snapshot:{" "}
          {data.captured_at
            ? new Date(data.captured_at).toLocaleString("en-GB", {
                timeZone: timezone,
              })
            : "unavailable"}
        </div>
      </header>
      <section className="search-row">
        <span aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search title, description, speaker, company, or topic"
        />
        {query || activeCount ? (
          <button
            className="clear"
            onClick={() => {
              setQuery("");
              setFilters({});
              setShowSpecialTracks(true);
              setPanelOnly(false);
            }}
          >
            Clear all
          </button>
        ) : null}
      </section>
      <section className="view-toolbar">
        <div className="segmented">
          <button
            className={view === "list" ? "active" : ""}
            onClick={() => setView("list")}
          >
            List
          </button>
          <button
            className={view === "calendar" ? "active" : ""}
            onClick={() => setView("calendar")}
          >
            Calendar
          </button>
        </div>
        {view === "calendar" ? (
          <>
            <div className="segmented">
              <button
                className={calendarMode === "rooms" ? "active" : ""}
                onClick={() => setCalendarMode("rooms")}
              >
                Rooms
              </button>
              <button
                className={calendarMode === "tracks" ? "active" : ""}
                onClick={() => setCalendarMode("tracks")}
              >
                Tracks
              </button>
            </div>
            <div className="segmented" aria-label="Calendar row height">
              <button
                className={calendarDensity === "standard" ? "active" : ""}
                onClick={() => setCalendarDensity("standard")}
              >
                Standard height
              </button>
              <button
                className={calendarDensity === "tall" ? "active" : ""}
                onClick={() => setCalendarDensity("tall")}
              >
                Tall rows
              </button>
            </div>
            {hiddenColumns.size ? (
              <button
                className="restore-columns"
                onClick={() =>
                  calendarMode === "rooms"
                    ? setHiddenRooms(new Set())
                    : setHiddenTracks(new Set())
                }
              >
                Show {hiddenColumns.size} hidden{" "}
                {calendarMode === "rooms" ? "room(s)" : "track(s)"}
              </button>
            ) : null}
            {expandedColumns.size ? (
              <button
                className="restore-columns"
                onClick={() =>
                  calendarMode === "rooms"
                    ? setExpandedRooms(new Set())
                    : setExpandedTracks(new Set())
                }
              >
                Reset {expandedColumns.size} expanded column(s)
              </button>
            ) : null}
          </>
        ) : null}
        <span className="result-count">
          {results.length} matching sessions · {timezone}
        </span>
      </section>
      {view === "calendar" ? (
        <div className="filter-strip">
          <div className="calendar-filter-heading">
            Filters {activeCount ? `(${activeCount})` : ""}
          </div>
          {filterContent(true)}
        </div>
      ) : null}
      {view === "list" ? (
        <section
          className="list-workspace"
          style={{
            gridTemplateColumns: `${widths.filters}px 8px minmax(360px, 1fr) 8px ${widths.details}px`,
          }}
        >
          <aside className="list-filters">
            <div className="filter-heading">
              <h2>Filters</h2>
              <span>
                {activeCount ? `${activeCount} selected` : "All sessions"}
              </span>
            </div>
            {filterContent()}
          </aside>
          <button
            className="resize-handle"
            aria-label="Resize filters"
            onPointerDown={(event) => resize("filters", event)}
          />
          <section className="session-list">
            <div className="list-heading">
              <h2>{results.length} matching sessions</h2>
            </div>
            {results.map((session) => (
              <button
                key={session.session_id}
                className={`session-card ${selected?.session_id === session.session_id ? "selected" : ""}`}
                onClick={() => selectSession(session)}
              >
                <div className="session-time">
                  <strong>{dateText(session.starts_at, timezone)}</strong>
                  <span>
                    {timeText(session.starts_at, timezone)}–
                    {timeText(session.ends_at, timezone)}
                  </span>
                </div>
                <div className="session-main">
                  <p className="session-event">
                    {session.event_name} · {session.track_name || "Main track"}
                  </p>
                  <h3>{session.title}</h3>
                  <p className="session-meta">
                    {[session.location, session.meeting_room]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {isPanel(session) ? (
                    <span className="panel-tag">Panel</span>
                  ) : null}
                </div>
              </button>
            ))}
          </section>
          <button
            className="resize-handle"
            aria-label="Resize details"
            onPointerDown={(event) => resize("details", event)}
          />
          <aside className="details list-details">{detailContent()}</aside>
        </section>
      ) : (
        <section className="calendar-view">
          <nav className="day-tabs">
            {dates.map((day) => (
              <button
                key={day}
                className={day === activeDay ? "active" : ""}
                onClick={() => setCalendarDay(day)}
              >
                {dateText(`${day}T00:00:00`, timezone)}
              </button>
            ))}
            <div className="time-window-presets" aria-label="Time zoom presets">
              <button
                className={
                  windowStart === fullStartMinute && windowEnd === fullEndMinute
                    ? "active"
                    : ""
                }
                onClick={() => setTimeWindow(fullStartMinute, fullEndMinute)}
              >
                All day
              </button>
              <button
                onClick={() =>
                  setTimeWindow(
                    fullStartMinute,
                    Math.min(
                      fullEndMinute,
                      Math.max(fullStartMinute + 180, 13 * 60),
                    ),
                  )
                }
              >
                Morning
              </button>
              <button
                onClick={() =>
                  setTimeWindow(
                    Math.max(
                      fullStartMinute,
                      Math.min(fullEndMinute - 180, 13 * 60),
                    ),
                    fullEndMinute,
                  )
                }
              >
                Afternoon
              </button>
            </div>
          </nav>
          {columns.length ? (
            <div className="calendar-scroll">
              <div
                className={`calendar-board ${calendarRangeSelection ? "range-selecting" : ""}`}
                ref={calendarBoardRef}
                onPointerDown={beginCalendarRangeSelection}
                onPointerMove={moveCalendarRangeSelection}
                onPointerUp={endCalendarRangeSelection}
                onPointerCancel={endCalendarRangeSelection}
                style={{
                  gridTemplateColumns: `72px ${columns.map((column) => `${columnWidth(column)}px`).join(" ")}`,
                  gridTemplateRows: `52px ${windowRange * pixelsPerMinute}px`,
                  minWidth: `${72 + columns.reduce((total, column) => total + columnWidth(column), 0)}px`,
                  height: `${windowRange * pixelsPerMinute + 52}px`,
                }}
              >
                <div className="time-corner">
                  <span>Time</span>
                  <small>
                    {minuteLabel(windowStart)}–{minuteLabel(windowEnd)}
                  </small>
                  <button
                    className="time-window-reset"
                    aria-label="Reset time zoom"
                    title="Reset time zoom"
                    onClick={() =>
                      setTimeWindow(fullStartMinute, fullEndMinute)
                    }
                  >
                    ↻
                  </button>
                </div>
                {columns.map((column) => (
                  <div className="calendar-column-title" key={column}>
                    <span>{column}</span>
                    <button
                      aria-label={`${expandedColumns.has(column) ? "Restore" : "Expand"} ${column}`}
                      onClick={() => toggleColumnExpansion(column)}
                    >
                      ↔
                    </button>
                    <button
                      aria-label={`Hide ${column}`}
                      onClick={() => hideColumn(column)}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="time-axis">
                  <div
                    className="time-window-track"
                    ref={timeWindowTrackRef}
                    onPointerDown={beginTimeWindowDrag}
                    onPointerMove={moveTimeWindow}
                    onPointerUp={endTimeWindowDrag}
                    onPointerCancel={endTimeWindowDrag}
                    aria-label="Calendar time zoom"
                  >
                    <div
                      className="time-window-selection"
                      data-time-window-selection
                      style={{
                        top: `${((windowStart - fullStartMinute) / fullRange) * 100}%`,
                        height: `${(windowRange / fullRange) * 100}%`,
                      }}
                    />
                    <div
                      className="time-window-handle"
                      data-time-window-handle="start"
                      style={{
                        top: `${((windowStart - fullStartMinute) / fullRange) * 100}%`,
                      }}
                      aria-label="Adjust time window start"
                    />
                    <div
                      className="time-window-handle"
                      data-time-window-handle="end"
                      style={{
                        top: `${((windowEnd - fullStartMinute) / fullRange) * 100}%`,
                      }}
                      aria-label="Adjust time window end"
                    />
                  </div>
                  {hourLabels.map((minute) => (
                    <span
                      key={minute}
                      style={{
                        top: `${(minute - windowStart) * pixelsPerMinute}px`,
                      }}
                    >
                      {String(Math.floor(minute / 60)).padStart(2, "0")}:00
                    </span>
                  ))}
                </div>
                {columns.map((column, index) => (
                  <div
                    className="calendar-column"
                    key={column}
                    style={{ gridColumn: index + 2 }}
                  >
                    {hourLabels.map((minute) => (
                      <i
                        key={minute}
                        style={{
                          top: `${(minute - windowStart) * pixelsPerMinute}px`,
                        }}
                      />
                    ))}
                    {laneLayout(
                      daySessions.filter(
                        (session) => columnKey(session) === column,
                      ),
                    ).map(({ session, lane, laneCount }) => {
                      const visibleStart = Math.max(
                        windowStart,
                        minuteOfDay(session.starts_at),
                      );
                      const visibleEnd = Math.min(
                        windowEnd,
                        minuteOfDay(session.ends_at),
                      );
                      const top =
                        (visibleStart - windowStart) * pixelsPerMinute;
                      const height = Math.max(
                        34,
                        (visibleEnd - visibleStart) * pixelsPerMinute - 4,
                      );
                      const style = {
                        top: `${top}px`,
                        height: `${height}px`,
                        left: `calc(${(lane * 100) / laneCount}% + 3px)`,
                        width: `calc(${100 / laneCount}% - 6px)`,
                        ...(session.track_color
                          ? { "--track-color": session.track_color }
                          : {}),
                      } as CSSProperties;
                      return (
                        <button
                          className={`calendar-card ${session.track_color ? "track-colored" : ""} ${isSpecialTrack(session) ? "special" : ""} ${minuteOfDay(session.starts_at) < windowStart ? "clipped-start" : ""} ${minuteOfDay(session.ends_at) > windowEnd ? "clipped-end" : ""}`}
                          style={style}
                          key={session.session_id}
                          onClick={() => selectSession(session)}
                        >
                          <strong>
                            {timeText(session.starts_at, timezone)}
                          </strong>
                          <span className="calendar-card-title">
                            {session.title}
                          </span>
                          <span className="calendar-card-tags">
                            {calendarTags(session).map((tag) => (
                              <i key={tag}>{tag}</i>
                            ))}
                          </span>
                          {isPanel(session) ? <em>Panel</em> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {calendarRangeSelection ? (
                  <div
                    className="calendar-range-selection"
                    style={{
                      left: `${Math.min(calendarRangeSelection.startX, calendarRangeSelection.currentX)}px`,
                      top: `${Math.min(calendarRangeSelection.startY, calendarRangeSelection.currentY)}px`,
                      width: `${Math.abs(calendarRangeSelection.currentX - calendarRangeSelection.startX)}px`,
                      height: `${Math.abs(calendarRangeSelection.currentY - calendarRangeSelection.startY)}px`,
                    }}
                  />
                ) : null}
              </div>
            </div>
          ) : (
            <div className="empty">
              No visible calendar columns. Use “Show hidden” to restore rooms or
              tracks.
            </div>
          )}
        </section>
      )}
      <button
        className="detail-backdrop"
        aria-label="Close session details"
        data-open={detailOpen}
        onClick={() => setDetailOpen(false)}
      />
      <aside
        className={`details floating-details ${view} ${detailOpen ? "open" : ""}`}
        aria-label="Session details"
      >
        <button
          className="detail-close"
          onClick={() => setDetailOpen(false)}
          aria-label="Close session details"
        >
          ×
        </button>
        {detailContent()}
      </aside>
    </main>
  );
}

export default function Home() {
  return <ScheduleExplorer />;
}
