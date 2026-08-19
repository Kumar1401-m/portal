/**
 * The pieces a printed document is made of — shared by the monthly report and
 * the invoice.
 *
 * Two documents is the point at which the paper chrome stops being part of a
 * page and becomes a thing of its own: the A4 page box, the rule that colour
 * must survive printing, the header carrying the agency's own details, the
 * footer. Written twice they drift, and a client ends up holding an invoice
 * that does not look like the report that came with it.
 *
 * Deliberately single-theme. A document that will be printed or forwarded is
 * white paper with dark ink whatever the person making it has their portal set
 * to, so everything here uses fixed colours rather than the app's tokens.
 */
import type { ReactNode } from "react";
// The palette and the slicing arithmetic live next door, where a test can
// import them without pulling in JSX.
import { SERIES, type Slice } from "@/lib/chart-slices";
export { SERIES, REST, toSlices, type Slice } from "@/lib/chart-slices";

export const INK = {
  text: "#171717",
  soft: "#525252",
  faint: "#737373",
  rule: "#e5e5e5",
  brand: "#ea580c",
} as const;

/**
 * A donut, drawn with dash offsets rather than arc paths.
 *
 * One circle per segment with a dash pattern is a fraction of the arithmetic
 * of hand-authored arc paths and cannot produce a malformed path — and no
 * charting library is worth pulling in for a page whose whole job is to be
 * printed. The 2px shortening on each segment is the gap between them, so
 * neighbouring slices never merge into one shape.
 */
export function Donut({
  slices,
  total,
  caption,
  size = 132,
}: {
  slices: Slice[];
  total: number;
  /** What the number in the middle counts. */
  caption: string;
  size?: number;
}) {
  const stroke = 22;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gap = total > 0 && slices.length > 1 ? 2 : 0;

  /*
   * Where each segment starts, worked out up front.
   *
   * A running total mutated inside the map would be the obvious way to write
   * this and React's compiler refuses it — a render that mutates as it goes
   * cannot be replayed. The running sum is the segment's own data, so it is
   * computed with the rest of it.
   */
  const arcs = slices.map((s, i) => ({
    ...s,
    length: total > 0 ? (s.value / total) * c : 0,
    start: total > 0 ? (slices.slice(0, i).reduce((t, p) => t + p.value, 0) / total) * c : 0,
  }));

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={caption}>
      <g transform={`translate(${size / 2} ${size / 2}) rotate(-90)`}>
        {/* The track, so a mostly-empty donut still reads as a ring. */}
        <circle r={r} fill="none" stroke="#f5f5f5" strokeWidth={stroke} />
        {arcs.map((a) => {
          const drawn = Math.max(0, a.length - gap);
          return (
            <circle
              key={a.label}
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth={stroke}
              strokeDasharray={`${drawn} ${c - drawn}`}
              strokeDashoffset={-a.start}
            />
          );
        })}
      </g>
      <text
        x={size / 2}
        y={size / 2 - 2}
        textAnchor="middle"
        fontSize="22"
        fontWeight="600"
        fill={INK.text}
      >
        {total}
      </text>
      <text x={size / 2} y={size / 2 + 14} textAnchor="middle" fontSize="9" fill={INK.faint}>
        {caption}
      </text>
    </svg>
  );
}

/** The names and shares, beside the donut. Identity never rests on colour alone. */
export function Legend({ slices, total }: { slices: Slice[]; total: number }) {
  return (
    <ul className="min-w-0 flex-1 space-y-1.5">
      {slices.map((s) => (
        <li key={s.label} className="flex items-baseline gap-2 text-sm">
          <span
            className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: s.color }}
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate" style={{ color: INK.soft }}>
            {s.label}
          </span>
          <span className="tabular-nums" style={{ color: INK.text }}>
            {s.value}
          </span>
          <span className="w-10 text-right tabular-nums text-xs" style={{ color: INK.faint }}>
            {total > 0 ? Math.round((s.value / total) * 100) : 0}%
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Followers, and how much of that arrived this month.
 *
 * Not a pie. Growth split across two platforms is a two-slice pie, which is a
 * shape that says less than the two numbers it is made of — where the reader's
 * question is "how much of this is new", one bar with the new part on the end
 * answers it directly and stays honest when the gain is 1%.
 */
export function GrowthBars({
  rows,
}: {
  rows: { platform: string; followers: number; gained: number }[];
}) {
  const max = Math.max(...rows.map((r) => r.followers), 1);
  return (
    <div className="space-y-3">
      {rows.map((r, i) => {
        const width = (r.followers / max) * 100;
        // The gain is drawn against the same scale as the total, so a small
        // month looks like a small month.
        const gainedPct = r.followers > 0 ? (Math.max(0, r.gained) / r.followers) * 100 : 0;
        return (
          <div key={r.platform}>
            <div className="flex items-baseline justify-between text-sm">
              <span style={{ color: INK.soft }}>{r.platform}</span>
              <span className="tabular-nums" style={{ color: INK.text }}>
                {r.followers.toLocaleString("en-IN")}
                <span className="ml-2 text-xs" style={{ color: r.gained >= 0 ? SERIES[2] : INK.faint }}>
                  {r.gained >= 0 ? "+" : ""}
                  {r.gained.toLocaleString("en-IN")} this month
                </span>
              </span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-sm" style={{ background: "#f5f5f5" }}>
              <div className="flex h-full" style={{ width: `${width}%` }}>
                <div style={{ width: `${100 - gainedPct}%`, background: SERIES[i % SERIES.length] }} />
                {/* The month's gain, in its own colour on the end of the bar. */}
                <div style={{ width: `${gainedPct}%`, background: SERIES[2] }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border px-4 py-3" style={{ borderColor: INK.rule }}>
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: INK.faint }}>
        {label}
      </p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums" style={{ color: INK.text }}>
        {value}
      </p>
      {sub ? (
        <p className="text-xs" style={{ color: INK.faint }}>
          {sub}
        </p>
      ) : null}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 break-inside-avoid">
      <h2
        className="border-b pb-1 text-sm font-semibold uppercase tracking-wide"
        style={{ borderColor: INK.rule, color: INK.brand }}
      >
        {title}
      </h2>
      <div className="mt-2 text-sm leading-relaxed" style={{ color: INK.soft }}>
        {children}
      </div>
    </section>
  );
}

export type Agency = {
  company_name: string;
  company_logo_url: string;
  contact_number: string;
  company_email: string;
  business_address: string;
  powered_by: string;
};

/**
 * The sheet itself: page box, print rules, the agency's letterhead and footer.
 *
 * `kicker` and `title` are the top-right block — "Monthly report / August 2026"
 * or "Invoice / INV-2026-0007" — so the two documents are recognisably the
 * same stationery.
 */
export function Paper({
  agency,
  kicker,
  title,
  children,
  controls,
}: {
  agency: Agency;
  kicker: string;
  title: string;
  children: ReactNode;
  /** Shown above the sheet on screen, never printed. */
  controls?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-neutral-100 py-6 print:bg-white print:py-0">
      {/* Print rules live with the documents they serve — nothing else in the
          portal is printed, so they have no business in the app stylesheet. */}
      <style>{`
        @page { size: A4; margin: 14mm; }
        @media print {
          html, body { background: #fff !important; }
          /* The brand rule, the chart slices and the table lines are the
             document, not decoration, so they have to survive the browser's
             default "don't print background colour". */
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      {controls ? (
        <div className="mx-auto mb-3 flex max-w-[820px] items-center justify-between gap-3 px-4 print:hidden">
          {controls}
        </div>
      ) : null}

      <article
        className="mx-auto max-w-[820px] bg-white p-10 shadow-sm print:max-w-none print:p-0 print:shadow-none"
        style={{ color: INK.text }}
      >
        <header
          className="flex items-start justify-between gap-6 border-b-2 pb-4"
          style={{ borderColor: INK.brand }}
        >
          <div className="min-w-0">
            {agency.company_logo_url ? (
              /* A plain <img>, not next/image: this page is printed, and the
                 optimiser's lazy loading is one more thing between the logo and
                 the paper. */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={agency.company_logo_url}
                alt={agency.company_name}
                className="mb-2 h-10 w-auto object-contain"
              />
            ) : (
              <p className="text-xl font-semibold tracking-tight">{agency.company_name}</p>
            )}
            <p className="text-xs" style={{ color: INK.faint }}>
              {[agency.contact_number, agency.company_email].filter(Boolean).join(" · ")}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p
              className="text-[11px] font-semibold uppercase tracking-widest"
              style={{ color: INK.faint }}
            >
              {kicker}
            </p>
            <p className="text-lg font-semibold" style={{ color: INK.brand }}>
              {title}
            </p>
          </div>
        </header>

        {children}

        <footer
          className="mt-8 flex items-end justify-between gap-4 border-t pt-3 text-xs"
          style={{ borderColor: INK.rule, color: INK.faint }}
        >
          <p>
            {agency.business_address || agency.company_name}
            {agency.contact_number ? ` · ${agency.contact_number}` : ""}
          </p>
          <p className="shrink-0 text-right">{agency.powered_by}</p>
        </footer>
      </article>
    </div>
  );
}
