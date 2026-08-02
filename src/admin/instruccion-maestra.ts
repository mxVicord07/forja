import { SETTING_KEYS } from "../db/settings";

export interface HistoryRow {
  key: string;
  old_value: string | null;
  new_value: string;
  actor: string;
  changed_at: number;
}

/** Setting keys whose values must never appear in plaintext in the generated doc. */
export const REDACTED_KEYS: readonly string[] = [SETTING_KEYS.llmApiKey];

const MAX_DIFF_LINES = 8;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(11, 16); // HH:MM UTC
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
}

function redact(key: string, value: string): string {
  return REDACTED_KEYS.includes(key) ? "••••" : value;
}

function renderLessonsDiff(oldValue: string | null, newValue: string): string {
  const parse = (raw: string | null): string[] => {
    try {
      const parsed = JSON.parse(raw ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((l) => typeof l === "string") : [];
    } catch {
      return [];
    }
  };
  const before = parse(oldValue);
  const after = parse(newValue);
  const added = after.filter((l) => !before.includes(l));
  const removed = before.filter((l) => !after.includes(l));
  const lines = [
    ...added.map((l) => `  + "${l}"`),
    ...removed.map((l) => `  - "${l}"`),
  ];
  return lines.length > 0 ? lines.join("\n") : "  (sin cambios netos)";
}

function renderLineDiff(oldValue: string | null, newValue: string): string {
  const oldLines = (oldValue ?? "").split("\n");
  const newLines = newValue.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const changed: string[] = [];
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (oldLines[i] !== undefined) changed.push(`  - ${oldLines[i]}`);
      if (newLines[i] !== undefined) changed.push(`  + ${newLines[i]}`);
    }
  }
  if (changed.length === 0) return "  (sin cambios de contenido)";
  const shown = changed.slice(0, MAX_DIFF_LINES);
  const hidden = changed.length - shown.length;
  return hidden > 0
    ? `${shown.join("\n")}\n  …y ${hidden} línea(s) más`
    : shown.join("\n");
}

export function renderChangelogEntry(row: HistoryRow): string {
  const header = `- ${fmtTime(row.changed_at)} · **${row.actor}** · ${row.key}`;

  if (REDACTED_KEYS.includes(row.key)) {
    return `${header}\n  •••• → ••••`;
  }

  if (row.key === SETTING_KEYS.learnedLessons) {
    return `${header}\n${renderLessonsDiff(row.old_value, row.new_value)}`;
  }

  const isLong = (row.old_value?.length ?? 0) > 80 || row.new_value.length > 80;
  if (isLong) {
    return `${header}\n${renderLineDiff(row.old_value, row.new_value)}`;
  }

  const before = redact(row.key, row.old_value ?? "");
  const after = redact(row.key, row.new_value);
  return `${header}\n  "${before}" → "${after}"`;
}

export function renderChangelog(rows: HistoryRow[]): string {
  if (rows.length === 0) return "## Changelog";

  const byDay = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const day = fmtDate(row.changed_at);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(row);
  }

  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
  const sections = days.map((day) => {
    const entries = byDay
      .get(day)!
      .sort((a, b) => a.changed_at - b.changed_at)
      .map(renderChangelogEntry)
      .join("\n");
    return `### ${day}\n${entries}`;
  });

  return `## Changelog\n${sections.join("\n\n")}`;
}
