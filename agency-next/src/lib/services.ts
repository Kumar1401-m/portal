/**
 * The agency's service taxonomy — the single source of truth for what a task
 * *is*. Every task belongs to one Service and (optionally) one Category.
 *
 * Safe to import from client components: no DB, no `server-only`.
 *
 * Storage note: the service lives in `deliverables.service` and the category
 * reuses the pre-existing `deliverables.content_category` column. The legacy
 * `video_type` column is still written (see `videoTypeForService`) so the
 * poster workflow, the monthly report split and the client portal keep
 * behaving exactly as they did before.
 */

export const SERVICE_KEYS = [
  "video_editing",
  "poster_designing",
  "website_development",
  "meta_ads",
  "content_writing",
  "social_media_posting",
] as const;

export type ServiceKey = (typeof SERVICE_KEYS)[number];

export type ServiceDef = {
  key: ServiceKey;
  label: string;
  /** Short label for tabs and tight columns. */
  short: string;
  color: string;
  /** Chip / badge styling (light + dark). */
  chip: string;
  /** Solid dot or bar — for list markers, progress bars, notifications. */
  dot: string;
  /** Left accent border for task cards. */
  accent: string;
  /** Soft tinted surface for cards and stat tiles. */
  surface: string;
  /** Active state for the service tabs. */
  tab: string;
};

/**
 * Colours are fixed per the agency's convention:
 *   Video → purple · Poster → orange · Website → blue
 *   Meta Ads → green · Content → pink · Social posting → cyan
 * Class strings are written out literally so Tailwind's scanner picks them up.
 */
export const SERVICES: Record<ServiceKey, ServiceDef> = {
  video_editing: {
    key: "video_editing",
    label: "Video Editing",
    short: "Videos",
    color: "purple",
    chip: "bg-purple-500/12 text-purple-700 ring-1 ring-inset ring-purple-500/30 dark:text-purple-300",
    dot: "bg-purple-500",
    accent: "border-l-purple-500",
    surface: "bg-purple-500/8 border-purple-500/20",
    tab: "bg-purple-500/12 text-purple-700 ring-1 ring-inset ring-purple-500/40 dark:text-purple-300",
  },
  poster_designing: {
    key: "poster_designing",
    label: "Poster Designing",
    short: "Posters",
    color: "orange",
    chip: "bg-orange-500/12 text-orange-700 ring-1 ring-inset ring-orange-500/30 dark:text-orange-300",
    dot: "bg-orange-500",
    accent: "border-l-orange-500",
    surface: "bg-orange-500/8 border-orange-500/20",
    tab: "bg-orange-500/12 text-orange-700 ring-1 ring-inset ring-orange-500/40 dark:text-orange-300",
  },
  website_development: {
    key: "website_development",
    label: "Website Development",
    short: "Website",
    color: "blue",
    chip: "bg-blue-500/12 text-blue-700 ring-1 ring-inset ring-blue-500/30 dark:text-blue-300",
    dot: "bg-blue-500",
    accent: "border-l-blue-500",
    surface: "bg-blue-500/8 border-blue-500/20",
    tab: "bg-blue-500/12 text-blue-700 ring-1 ring-inset ring-blue-500/40 dark:text-blue-300",
  },
  meta_ads: {
    key: "meta_ads",
    label: "Meta Ads Management",
    short: "Meta Ads",
    color: "green",
    chip: "bg-green-500/12 text-green-700 ring-1 ring-inset ring-green-500/30 dark:text-green-300",
    dot: "bg-green-500",
    accent: "border-l-green-500",
    surface: "bg-green-500/8 border-green-500/20",
    tab: "bg-green-500/12 text-green-700 ring-1 ring-inset ring-green-500/40 dark:text-green-300",
  },
  content_writing: {
    key: "content_writing",
    label: "Content Writing",
    short: "Content",
    color: "pink",
    chip: "bg-pink-500/12 text-pink-700 ring-1 ring-inset ring-pink-500/30 dark:text-pink-300",
    dot: "bg-pink-500",
    accent: "border-l-pink-500",
    surface: "bg-pink-500/8 border-pink-500/20",
    tab: "bg-pink-500/12 text-pink-700 ring-1 ring-inset ring-pink-500/40 dark:text-pink-300",
  },
  social_media_posting: {
    key: "social_media_posting",
    label: "Social Media Posting",
    short: "Social",
    color: "cyan",
    chip: "bg-cyan-500/12 text-cyan-700 ring-1 ring-inset ring-cyan-500/30 dark:text-cyan-300",
    dot: "bg-cyan-500",
    accent: "border-l-cyan-500",
    surface: "bg-cyan-500/8 border-cyan-500/20",
    tab: "bg-cyan-500/12 text-cyan-700 ring-1 ring-inset ring-cyan-500/40 dark:text-cyan-300",
  },
};

export const SERVICE_LIST: ServiceDef[] = SERVICE_KEYS.map((k) => SERVICES[k]);

export function isServiceKey(v: unknown): v is ServiceKey {
  return typeof v === "string" && (SERVICE_KEYS as readonly string[]).includes(v);
}

/**
 * Resolve a task's service. Rows created before the taxonomy existed have a
 * NULL `service`, so fall back to the legacy `video_type` the same way the
 * migration backfill does — the UI never shows an untagged task.
 */
export function serviceOf(row: {
  service?: string | null;
  video_type?: string | null;
}): ServiceKey {
  if (isServiceKey(row.service)) return row.service;
  if (String(row.video_type || "").toLowerCase() === "poster") return "poster_designing";
  return "video_editing";
}

export function serviceDef(row: { service?: string | null; video_type?: string | null }): ServiceDef {
  return SERVICES[serviceOf(row)];
}

/**
 * Keep the legacy `video_type` in step with the service so nothing downstream
 * breaks: the Posters module, `poster/actions.ts` and the reports scorecard all
 * still key off `video_type IN ('Poster','Reel')`.
 */
export function videoTypeForService(service: ServiceKey, category: string | null): string {
  if (service === "poster_designing") return "Poster";
  if (service === "video_editing") {
    const c = (category || "").toLowerCase();
    if (c.includes("advertisement") || c.includes("ad copy")) return "Ad";
    if (c.includes("long") || c.includes("podcast") || c.includes("event")) return "Other";
    return "Reel";
  }
  return "Other";
}

/**
 * Fallback category lists, used when the `task_categories` table can't be read
 * (e.g. the migration hasn't run yet). The table is the real source of truth —
 * admins add and rename categories in Settings → Task categories.
 */
export const DEFAULT_CATEGORIES: Record<ServiceKey, string[]> = {
  video_editing: [
    "Instagram Reel",
    "YouTube Short",
    "YouTube Long Video",
    "Lead Magnet Reel",
    "Graphic Reel",
    "Promotional Video",
    "Testimonial Video",
    "Educational Video",
    "Podcast",
    "Event Video",
    "Advertisement Video",
  ],
  poster_designing: [
    "Educational Poster",
    "Offer Poster",
    "Festival Poster",
    "Awareness Poster",
    "Promotional Poster",
    "Announcement Poster",
    "Social Media Post",
    "Thumbnail",
    "Banner",
  ],
  website_development: [
    "Landing Page",
    "Business Website",
    "Portfolio Website",
    "Ecommerce Website",
    "Maintenance",
    "Bug Fix",
  ],
  meta_ads: [
    "Lead Generation",
    "Awareness Campaign",
    "Engagement Campaign",
    "Traffic Campaign",
    "Conversion Campaign",
    "Remarketing",
  ],
  content_writing: [
    "Instagram Caption",
    "Facebook Caption",
    "YouTube Description",
    "Blog",
    "Ad Copy",
    "Script",
    "Lead Magnet PDF",
  ],
  social_media_posting: [
    "Instagram Post",
    "Instagram Story",
    "Facebook Post",
    "YouTube Upload",
    "LinkedIn Post",
    "Scheduled Posting",
  ],
};

/** Parse the `clients.services` JSON column into a clean key list. */
export function parseClientServices(v: unknown): ServiceKey[] {
  let raw: unknown = v;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isServiceKey);
}
