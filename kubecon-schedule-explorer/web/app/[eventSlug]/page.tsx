import { readFile } from "node:fs/promises";
import path from "node:path";

import { ScheduleExplorer } from "../page";

type EventIndex = { events: { slug: string }[] };

export async function generateStaticParams() {
  const indexPath = path.join(
    process.cwd(),
    "public",
    "data",
    "events",
    "index.json",
  );
  const index = JSON.parse(
    await readFile(indexPath, "utf8"),
  ) as EventIndex;
  return index.events.map(({ slug }) => ({ eventSlug: slug }));
}

export default async function EventSchedulePage({
  params,
}: {
  params: Promise<{ eventSlug: string }>;
}) {
  const { eventSlug } = await params;
  return <ScheduleExplorer initialEventSlug={eventSlug} />;
}
