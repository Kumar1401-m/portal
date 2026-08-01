/**
 * CSV generation for the analytics exports.
 *
 * Excel-first, because that is what the file is actually opened in:
 *
 *   - A UTF-8 BOM is prepended. Without it Excel on Windows reads the file as
 *     the local ANSI codepage and a client called "Café Ravi" arrives as
 *     "CafÃ© Ravi".
 *   - Fields are separated by commas and always quoted when they could be
 *     ambiguous — a company name with a comma in it is otherwise two columns.
 *   - A leading =, +, - or @ is neutralised. Excel treats those as the start of
 *     a formula, so a caption beginning "=" becomes a live cell reference on
 *     open. This is the CSV-injection class of bug, and it matters here because
 *     captions are user-supplied text that ends up in a file other people open.
 *
 * A real .xlsx would need a zip writer and an OOXML schema for no gain: Excel,
 * Numbers, LibreOffice and Google Sheets all open this directly.
 */

export type CsvValue = string | number | null | undefined;

const RISKY_PREFIX = /^[=+\-@\t\r]/;

function escapeCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";

  let s = String(value);
  // Neutralise a formula trigger by prefixing a single quote, which Excel
  // treats as "this cell is text" and doesn't display.
  if (RISKY_PREFIX.test(s)) s = `'${s}`;
  // A newline inside a quoted field is legal CSV, but it makes the file hard to
  // read in anything simpler than a spreadsheet, so collapse it.
  s = s.replace(/[\r\n]+/g, " ");

  return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells: CsvValue[]) => cells.map(escapeCell).join(",");

/** One table: a header row followed by data rows. */
export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [row(headers), ...rows.map(row)].join("\r\n");
}

export type CsvSection = { title: string; headers: string[]; rows: CsvValue[][] };

/**
 * Several tables in one file, separated by a titled blank line.
 *
 * A single export carrying summary, daily series and top posts is more useful
 * than three downloads, and every spreadsheet handles the ragged shape — it
 * simply leaves the short rows short.
 */
export function toCsvWorkbook(sections: CsvSection[]): string {
  const blocks = sections.map((s) =>
    [row([s.title]), row(s.headers), ...s.rows.map(row)].join("\r\n")
  );
  // The BOM goes on once, at the very start of the file.
  return `﻿${blocks.join("\r\n\r\n")}\r\n`;
}

/** A filename-safe slug — no quotes or path separators to break the header. */
export function csvFilename(parts: (string | null | undefined)[]): string {
  const slug = parts
    .filter(Boolean)
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
  return `${slug || "analytics"}.csv`;
}

/** The response, with the headers that make a browser download rather than render. */
export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // An export is a point-in-time snapshot; caching it would serve
      // yesterday's numbers under today's filename.
      "Cache-Control": "no-store",
    },
  });
}
