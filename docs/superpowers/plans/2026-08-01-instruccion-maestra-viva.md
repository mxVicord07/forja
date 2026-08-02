# Instrucción Maestra Viva — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the owner an auditable, attributed changelog of every change to the bot's effective system prompt — especially the ones the nightly flywheel makes on its own — exported as a markdown file outside the repo.

**Architecture:** Capture happens at the single existing write chokepoint, `SettingsRepo.set()`. Every write that actually changes a value gets one atomic D1 batch: an insert into a new `settings_history` table plus the existing upsert into `settings`. An authenticated admin endpoint composes the effective prompt (via the existing `resolveAgentConfig()`) with a changelog rendered from that history table, redacting secret keys. A small Node script pulls that endpoint and writes the result to a file outside the repo (OneDrive), safely (temp file + validation before overwrite).

**Tech Stack:** TypeScript, Cloudflare Workers (D1, Hono), Vitest + Miniflare for tests, tsx for the standalone sync script.

## Global Constraints

- Every `SettingsRepo.set()` call site must keep compiling unchanged — `actor` is an optional third parameter defaulting to `"system"`.
- A history row is written **only when `old_value !== new_value`** — no-op saves must not create rows.
- The history insert and the settings upsert are one atomic D1 batch — never two separate awaits that could partially fail.
- `llm_api_key` (and any future secret-shaped setting key) must never appear in plaintext in the generated document, in either the "current state" section or the changelog.
- Retention for `settings_history` is 365 days, purged by the existing nightly cron (mirrors `MESSAGE_RETENTION_DAYS` pattern in `src/crons/purgeOldMessages.ts`).
- The generated `.md` file lives outside `~/Dev/forja` — the sync script writes to `FORJA/_context/instruccion-maestra.md` under OneDrive, path taken from an env var with a default, never hardcoded to one machine's absolute path in source.
- Migration (schema.sql change) must be applied to D1 (`pnpm db:apply` / `db:apply:remote`) **before** the code that depends on `settings_history` is deployed — the same order-of-operations hazard documented in `docs/canales/ycloud.md`.

---

### Task 1: `settings_history` table + `Db.batch()`

**Files:**
- Modify: `src/db/schema.sql` (append table)
- Modify: `src/db/client.ts` (add `batch()` method)
- Test: `test/db/client.test.ts` (new file)

**Interfaces:**
- Produces: `Db.batch(statements: { sql: string; params?: unknown[] }[]): Promise<void>` — runs all statements as one atomic D1 batch. Later tasks (Task 2) depend on this exact signature.

- [ ] **Step 1: Append the table to schema.sql**

Add to the end of `src/db/schema.sql` (it already only contains idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements — follow that pattern):

```sql

-- Historial de cambios de `settings`, para auditoría/gobernanza de la
-- instrucción maestra (ver docs/superpowers/specs/2026-08-01-instruccion-maestra-viva-design.md).
-- Se escribe SOLO cuando SettingsRepo.set() detecta que el valor cambió de
-- verdad — el panel admin guarda todas las keys de un formulario de golpe,
-- así que sin esa comparación cada guardado generaría filas basura.
CREATE TABLE IF NOT EXISTS settings_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL,
  old_value  TEXT,              -- NULL = la key no existía antes de este cambio
  new_value  TEXT    NOT NULL,
  actor      TEXT    NOT NULL,  -- 'owner' | 'flywheel' | 'system'
  changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settings_history_changed ON settings_history(changed_at DESC);
```

- [ ] **Step 2: Write the failing test for `Db.batch()`**

Create `test/db/client.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";

let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
});

describe("Db.batch", () => {
  it("runs multiple statements atomically", async () => {
    await db.batch([
      { sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)", params: ["a", "1", 100] },
      { sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)", params: ["b", "2", 100] },
    ]);
    const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM settings ORDER BY key");
    expect(rows).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
  });

  it("supports statements with no params", async () => {
    await db.batch([
      { sql: "INSERT INTO settings (key, value, updated_at) VALUES ('x', 'y', 1)" },
    ]);
    expect(await db.first<{ value: string }>("SELECT value FROM settings WHERE key = 'x'")).toEqual({ value: "y" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/db/client.test.ts`
Expected: FAIL — `db.batch is not a function`

- [ ] **Step 4: Implement `Db.batch()`**

In `src/db/client.ts`, add after the existing `all()` method:

```typescript
  async batch(statements: { sql: string; params?: unknown[] }[]): Promise<void> {
    await this.d1.batch(
      statements.map((s) => this.d1.prepare(s.sql).bind(...(s.params ?? []))),
    );
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/db/client.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
cd ~/Dev/forja
git add src/db/schema.sql src/db/client.ts test/db/client.test.ts
git commit -m "feat(db): tabla settings_history + Db.batch() para escrituras atómicas"
```

---

### Task 2: Attribution + history capture in `SettingsRepo.set()`

**Files:**
- Modify: `src/db/settings.ts:39-45` (the `set()` method)
- Test: `test/db/settings.test.ts` (extend existing file)

**Interfaces:**
- Consumes: `Db.batch()` from Task 1 (exact signature above).
- Produces: `SettingsRepo.set(key: string, value: string, actor?: "owner" | "flywheel" | "system"): Promise<void>` — `actor` defaults to `"system"`. Task 3 and Task 5 depend on this signature and on rows landing in `settings_history` with columns `key, old_value, new_value, actor, changed_at`.

- [ ] **Step 1: Write the failing tests**

Append to `test/db/settings.test.ts` (inside the existing `describe("SettingsRepo", ...)` block, after the last `it`):

```typescript
  it("does not write a history row when the value is unchanged", async () => {
    await repo.set(SETTING_KEYS.tone, "cálido y cercano");
    await repo.set(SETTING_KEYS.tone, "cálido y cercano");
    const history = await repo.dbForTest.all<{ key: string }>("SELECT key FROM settings_history");
    expect(history).toHaveLength(1);
  });

  it("writes a history row with old_value NULL on the first write of a key", async () => {
    await repo.set(SETTING_KEYS.botName, "Pelusa");
    const rows = await repo.dbForTest.all<{ key: string; old_value: string | null; new_value: string; actor: string }>(
      "SELECT key, old_value, new_value, actor FROM settings_history",
    );
    expect(rows).toEqual([
      { key: SETTING_KEYS.botName, old_value: null, new_value: "Pelusa", actor: "system" },
    ]);
  });

  it("records old_value on a subsequent change", async () => {
    await repo.set(SETTING_KEYS.tone, "cálido y cercano");
    await repo.set(SETTING_KEYS.tone, "formal y profesional");
    const rows = await repo.dbForTest.all<{ old_value: string | null; new_value: string }>(
      "SELECT old_value, new_value FROM settings_history ORDER BY id",
    );
    expect(rows).toEqual([
      { old_value: null, new_value: "cálido y cercano" },
      { old_value: "cálido y cercano", new_value: "formal y profesional" },
    ]);
  });

  it("defaults actor to 'system' when not passed", async () => {
    await repo.set(SETTING_KEYS.botName, "Pelusa");
    const row = await repo.dbForTest.first<{ actor: string }>("SELECT actor FROM settings_history LIMIT 1");
    expect(row?.actor).toBe("system");
  });

  it("records the actor when passed explicitly", async () => {
    await repo.set(SETTING_KEYS.tone, "cálido", "owner");
    const row = await repo.dbForTest.first<{ actor: string }>("SELECT actor FROM settings_history LIMIT 1");
    expect(row?.actor).toBe("owner");
  });
```

This test file needs a way to reach the underlying `Db` for assertions — add a test-only accessor. At the top of `test/db/settings.test.ts`, change the `beforeEach` to also expose it:

```typescript
let repo: SettingsRepo;
let db: Db;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  db = new Db(d1 as any);
  repo = new SettingsRepo(db);
});
```

And replace every `repo.dbForTest` in the new tests above with `db` (this is simpler than adding a test-only accessor to the repo — use `db` directly, it's already in scope from `beforeEach`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/db/settings.test.ts`
Expected: FAIL — `no such table: settings_history` (if Task 1 wasn't run first) or the history rows are simply absent (0 instead of 1) because `set()` doesn't write them yet.

- [ ] **Step 3: Implement history capture in `set()`**

In `src/db/settings.ts`, replace the existing `set()` method:

```typescript
  async set(key: string, value: string, actor: "owner" | "flywheel" | "system" = "system"): Promise<void> {
    const previous = await this.get(key);
    if (previous === value) {
      await this.db.run(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, Date.now()],
      );
      return;
    }
    const now = Date.now();
    await this.db.batch([
      {
        sql: `INSERT INTO settings_history (key, old_value, new_value, actor, changed_at) VALUES (?, ?, ?, ?, ?)`,
        params: [key, previous, value, actor, now],
      },
      {
        sql: `INSERT INTO settings (key, value, updated_at)
              VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        params: [key, value, now],
      },
    ]);
  }
```

Note: when `previous === value` the method still runs the plain upsert (touches `updated_at`) but skips history — matches the "only record real changes" rule while keeping existing `updated_at`-bump behavior intact for any code that might rely on it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/db/settings.test.ts`
Expected: PASS (all tests, old + new)

- [ ] **Step 5: Run the full suite to confirm no regressions from the `set()` signature change**

Run: `pnpm test`
Expected: PASS (all files) — the third `actor` parameter is optional, so every existing call site (`src/admin/routes.ts`, `src/watchdog.ts`, `src/learn/mapping.ts`, `src/flywheel/detect.ts`) keeps compiling and behaving as before.

- [ ] **Step 6: Commit**

```bash
cd ~/Dev/forja
git add src/db/settings.ts test/db/settings.test.ts
git commit -m "feat(db): SettingsRepo.set() captura historial atómico con atribución"
```

---

### Task 3: Attribute the two callers that should not default to "system"

**Files:**
- Modify: `src/admin/routes.ts` (every `repo.set(...)` / `SettingsRepo(...).set(...)` call site that originates from an owner action in the admin panel)
- Modify: `src/flywheel/detect.ts:180-185` (`saveLessons`)
- Test: `test/flywheel/autonomy.test.ts` (extend), `test/admin/config-route.test.ts` (new file)

**Interfaces:**
- Consumes: `SettingsRepo.set(key, value, actor?)` from Task 2.
- Produces: nothing new — this task only changes call-site arguments, no new exports.

- [ ] **Step 1: Find every settings-write call site in the admin panel**

Run: `grep -n "\.set(" src/admin/routes.ts`

Expected output includes these lines (line numbers from the current file — re-check before editing since earlier tasks don't touch this file):
```
124:  await new SettingsRepo(new Db(c.env.DB)).set(SETTING_KEYS.monthlyBudget, value);
185:  await new SettingsRepo(new Db(c.env.DB)).set(SETTING_KEYS.twilioHandoffContentSid, r.sid);
232:  await new SettingsRepo(new Db(c.env.DB)).set(SETTING_KEYS.autonomyLevel, level);
329:    if (s !== null) await repo.set(SETTING_KEYS.bufferSeconds, String(Math.round(clamp(s, 1, 60))));
332:    if (chunks !== null) await repo.set(SETTING_KEYS.maxChunks, String(Math.round(clamp(chunks, 1, 5))));
335:      await repo.set(SETTING_KEYS.interChunkDelayMs, String(Math.round(clamp(delayS, 0, 5) * 1000)));
338:    if (m === "auto" || m === "haiku" || m === "sonnet") await repo.set(SETTING_KEYS.modelOverride, m);
340:    if (t !== null) await repo.set(SETTING_KEYS.temperature, String(clamp(t, 0, 1)));
345:      await repo.set(SETTING_KEYS.systemPromptOverride, "");
347:      await repo.set(SETTING_KEYS.botPaused, String(form.get("bot_paused")) === "1" ? "1" : "0");
349:      await repo.set(SETTING_KEYS.systemPromptOverride, String(form.get("system_prompt_override")).trim());
471:    if (value !== null) await repo.set(key, value);
484:    await repo.set(key, String(raw).trim());
491:    await repo.set(...)
498:    await repo.set(SETTING_KEYS.llmModel, String(modelRaw).trim().slice(0, 100));
```

All of these are owner-initiated (form submits, panel toggles) — every one of them gets `"owner"` appended as the third argument. Add `, "owner"` to the end of each `.set(...)` call's argument list in this file (16 call sites). Do this with a careful find-and-replace per line, not a blanket regex — some lines have multi-line argument lists (e.g. line 491).

- [ ] **Step 2: Attribute the flywheel's lesson writes**

In `src/flywheel/detect.ts`, find `saveLessons`:

```typescript
export async function saveLessons(env: Env, lessons: string[]): Promise<void> {
  await new SettingsRepo(new Db(env.DB)).set(
    SETTING_KEYS.learnedLessons,
    JSON.stringify(lessons.slice(-MAX_LESSONS)),
  );
}
```

Change to:

```typescript
export async function saveLessons(env: Env, lessons: string[]): Promise<void> {
  await new SettingsRepo(new Db(env.DB)).set(
    SETTING_KEYS.learnedLessons,
    JSON.stringify(lessons.slice(-MAX_LESSONS)),
    "flywheel",
  );
}
```

- [ ] **Step 3: Write a test confirming attribution end-to-end for the flywheel path**

`test/flywheel/autonomy.test.ts` already has an `it("aplica kb_entry completa y lección, salta kb_entry con hueco, y marca la evidencia", ...)` test (around line 67) that creates a `leccion` suggestion via `suggestions.createIfNew({ kind: "leccion", ... })` and calls `autoApplyPending(env)`, which internally calls `saveLessons`. Add a new `it` in the same `describe` block, right after that existing test, reusing the same `beforeEach`-provided `env`/`db`/`suggestions` (already in scope — no new setup needed):

```typescript
  it("attributes auto-applied lessons to 'flywheel' in settings_history", async () => {
    await suggestions.createIfNew({
      kind: "leccion",
      fingerprint: "conv:xyz",
      title: "Confirmar dirección antes de agendar visita",
      payload: { lesson: "Confirmar dirección antes de agendar visita" },
      evidence: "aprendida de tu takeover",
    });

    await autoApplyPending(env);

    const rows = await db.all<{ actor: string }>(
      "SELECT actor FROM settings_history WHERE key = 'learned_lessons'",
    );
    expect(rows.some((r) => r.actor === "flywheel")).toBe(true);
  });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run test/flywheel/autonomy.test.ts`
Expected: FAIL — `actor` is `"system"` instead of `"flywheel"` (this fails until Step 2's edit to `saveLessons` is in place).

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/flywheel/autonomy.test.ts`
Expected: PASS

- [ ] **Step 6: Add one admin-panel attribution test**

The settings-saving route is `POST /admin/config` (`src/admin/routes.ts:461`), which reads `SettingsRepo` writes from `multipart/form-data`/`urlencoded` form fields — free-text fields like `bot_name` are stored verbatim via `repo.set(key, String(raw).trim())` (`src/admin/routes.ts:481-484`), so `bot_name` is the simplest field to drive without depending on `levelToValue`'s card-option mapping (used only for the `CONTROLS` keys like `tone`).

Create `test/admin/config-route.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`, "utf-8").toString("base64")}` };

let env: Env;
let d1: any;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  d1 = await mf.getD1Database("DB");
  env = { DB: d1, DASHBOARD_PASSWORD: PASSWORD } as unknown as Env;
});

describe("POST /admin/config attribution", () => {
  it("attributes a panel change to 'owner' in settings_history", async () => {
    const form = new URLSearchParams({ bot_name: "Pelusa" });
    const res = await adminApp.request(
      "/config",
      { method: "POST", headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() },
      env,
    );
    expect(res.status).toBeLessThan(400);
    const rows = await d1.prepare("SELECT actor FROM settings_history WHERE key = 'bot_name'").all();
    expect(rows.results[0]).toMatchObject({ actor: "owner" });
  });
});
```

- [ ] **Step 7: Run it, verify pass, then run the full suite**

Run: `pnpm vitest run test/admin/config-route.test.ts test/flywheel/autonomy.test.ts && pnpm test`
Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
cd ~/Dev/forja
git add src/admin/routes.ts src/flywheel/detect.ts test/flywheel/autonomy.test.ts test/admin/config-route.test.ts
git commit -m "feat(settings): atribuye escrituras del panel a 'owner' y del flywheel a 'flywheel'"
```

---

### Task 4: Changelog renderer (pure function, no I/O)

**Files:**
- Create: `src/admin/instruccion-maestra.ts`
- Test: `test/admin/instruccion-maestra.test.ts`

**Interfaces:**
- Consumes: rows shaped like `{ key: string; old_value: string | null; new_value: string; actor: string; changed_at: number }` (matches `settings_history` columns from Task 1).
- Produces:
  - `const REDACTED_KEYS: readonly string[]` — list containing at minimum `SETTING_KEYS.llmApiKey`.
  - `function renderChangelogEntry(row: HistoryRow): string` — one rendered changelog line/block per row, applying the three rules from the spec (lessons diff / short value / long-text line-diff) and redacting values for keys in `REDACTED_KEYS`.
  - `function renderChangelog(rows: HistoryRow[]): string` — groups entries by date (`YYYY-MM-DD` in local rendering, entries within a day newest-first per the spec's example ordering — actually the spec's example shows chronological ascending within a day filter by "### 2026-08-01" then entries; implement ascending by `changed_at` within each day group, days descending), returns the full `## Changelog` section including the heading.
  - `interface HistoryRow { key: string; old_value: string | null; new_value: string; actor: string; changed_at: number }` — exported type, consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

Create `test/admin/instruccion-maestra.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { renderChangelog, renderChangelogEntry, REDACTED_KEYS, type HistoryRow } from "../../src/admin/instruccion-maestra";
import { SETTING_KEYS } from "../../src/db/settings";

function row(overrides: Partial<HistoryRow>): HistoryRow {
  return {
    key: SETTING_KEYS.tone,
    old_value: null,
    new_value: "formal",
    actor: "owner",
    changed_at: new Date("2026-08-01T21:40:00Z").getTime(),
    ...overrides,
  };
}

describe("renderChangelogEntry", () => {
  it("renders a short value change as before → after", () => {
    const line = renderChangelogEntry(row({ key: SETTING_KEYS.tone, old_value: "cálido", new_value: "formal" }));
    expect(line).toContain('"cálido" → "formal"');
    expect(line).toContain("owner");
  });

  it("renders old_value NULL as an empty-string before value", () => {
    const line = renderChangelogEntry(row({ old_value: null, new_value: "formal" }));
    expect(line).toContain('"" → "formal"');
  });

  it("renders learned_lessons as an added/removed diff, not raw JSON", () => {
    const line = renderChangelogEntry(
      row({
        key: SETTING_KEYS.learnedLessons,
        old_value: JSON.stringify(["a"]),
        new_value: JSON.stringify(["a", "b"]),
        actor: "flywheel",
      }),
    );
    expect(line).toContain('+ "b"');
    expect(line).not.toContain("[");
  });

  it("renders removed lessons with a minus", () => {
    const line = renderChangelogEntry(
      row({
        key: SETTING_KEYS.learnedLessons,
        old_value: JSON.stringify(["a", "b"]),
        new_value: JSON.stringify(["a"]),
      }),
    );
    expect(line).toContain('- "b"');
  });

  it("redacts llm_api_key values", () => {
    const line = renderChangelogEntry(
      row({ key: SETTING_KEYS.llmApiKey, old_value: "sk-old-secret", new_value: "sk-new-secret" }),
    );
    expect(line).not.toContain("sk-old-secret");
    expect(line).not.toContain("sk-new-secret");
    expect(line).toContain("••••");
  });

  it("diffs long text by line, truncating with a count of hidden lines", () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `línea ${i}`).join("\n");
    const newText = oldText.replace("línea 5", "línea 5 EDITADA");
    const line = renderChangelogEntry(
      row({ key: SETTING_KEYS.businessContext, old_value: oldText, new_value: newText }),
    );
    expect(line).toContain("línea 5 EDITADA");
    expect(line).not.toContain("línea 0\n"); // unchanged lines outside the shown window are omitted
  });
});

describe("renderChangelog", () => {
  it("groups entries under a date heading and includes the Changelog title", () => {
    const md = renderChangelog([row({ changed_at: new Date("2026-08-01T03:14:00Z").getTime() })]);
    expect(md).toContain("## Changelog");
    expect(md).toContain("### 2026-08-01");
  });

  it("returns just the heading with no entries for an empty history", () => {
    const md = renderChangelog([]);
    expect(md.trim()).toBe("## Changelog");
  });
});

describe("REDACTED_KEYS", () => {
  it("includes llm_api_key", () => {
    expect(REDACTED_KEYS).toContain(SETTING_KEYS.llmApiKey);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/admin/instruccion-maestra.test.ts`
Expected: FAIL — module `src/admin/instruccion-maestra.ts` does not exist.

- [ ] **Step 3: Implement the renderer**

Create `src/admin/instruccion-maestra.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/admin/instruccion-maestra.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
cd ~/Dev/forja
git add src/admin/instruccion-maestra.ts test/admin/instruccion-maestra.test.ts
git commit -m "feat(admin): renderer puro del changelog de la instrucción maestra"
```

---

### Task 5: `GET /admin/instruccion-maestra.md` endpoint

**Files:**
- Modify: `src/admin/routes.ts` (add route + imports)
- Modify: `src/admin/instruccion-maestra.ts` (add the document composer)
- Test: `test/admin/instruccion-maestra-route.test.ts`

**Interfaces:**
- Consumes: `renderChangelog(rows: HistoryRow[]): string`, `REDACTED_KEYS` from Task 4; `resolveAgentConfig(env, toolNames): Promise<AgentConfig>` from `src/settings-loader.ts` (existing, `AgentConfig` has `systemPrompt: string`, `enabledToolNames: string[]`, `modelOverride`, `botPaused`); `buildTools({ env, getConversationId })` from `src/tools.ts` (existing, used the same way as `src/admin/views/agente.ts:181`); `SettingsRepo.get(SETTING_KEYS.systemPromptOverride)`, `.get(SETTING_KEYS.learnedLessons)`, `.get(SETTING_KEYS.autonomyLevel)`, `.get(SETTING_KEYS.botLanguage)` (existing).
- Produces: `async function renderInstruccionMaestraDoc(env: Env): Promise<string>` in `src/admin/instruccion-maestra.ts` — the full markdown document. Mounted at `GET /admin/instruccion-maestra.md` in `routes.ts`, returning `Content-Type: text/markdown; charset=utf-8`. Task 6's sync script depends on this exact route path and content type.

- [ ] **Step 1: Write the failing route test**

Create `test/admin/instruccion-maestra-route.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import { Db } from "../../src/db/client";
import { SettingsRepo, SETTING_KEYS } from "../../src/db/settings";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";
const AUTH = { Authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`, "utf-8").toString("base64")}` };

let env: Env;
let repo: SettingsRepo;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = (await mf.getD1Database("DB")) as any;
  env = {
    DB: d1,
    DASHBOARD_PASSWORD: PASSWORD,
    BOT_NAME: "Testi",
    BUSINESS_NAME: "Test Business",
    BOT_LANGUAGE: "es",
    BOT_TIER: "pro",
  } as unknown as Env;
  repo = new SettingsRepo(new Db(d1));
});

describe("GET /admin/instruccion-maestra.md", () => {
  it("requires auth", async () => {
    const res = await adminApp.request("/instruccion-maestra.md", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns markdown with the effective prompt and a changelog", async () => {
    await repo.set(SETTING_KEYS.tone, "cálido", "owner");
    const res = await adminApp.request("/instruccion-maestra.md", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const body = await res.text();
    expect(body).toContain("# Instrucción Maestra");
    expect(body).toContain("## Prompt efectivo");
    expect(body).toContain("## Changelog");
    expect(body).toContain("owner");
  });

  it("warns when system_prompt_override is active", async () => {
    await repo.set(SETTING_KEYS.systemPromptOverride, "prompt manual custom", "owner");
    const res = await adminApp.request("/instruccion-maestra.md", { headers: AUTH }, env);
    const body = await res.text();
    expect(body).toContain("⚠️ Avisos");
    expect(body).toContain("system_prompt_override");
  });

  it("never leaks llm_api_key in plaintext", async () => {
    await repo.set(SETTING_KEYS.llmApiKey, "sk-super-secret-value", "owner");
    const res = await adminApp.request("/instruccion-maestra.md", { headers: AUTH }, env);
    const body = await res.text();
    expect(body).not.toContain("sk-super-secret-value");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/admin/instruccion-maestra-route.test.ts`
Expected: FAIL — 404, route doesn't exist yet.

- [ ] **Step 3: Implement the document composer**

Append to `src/admin/instruccion-maestra.ts` (same file as Task 4's renderer):

```typescript
import type { Env } from "../env";
import { Db } from "../db/client";
import { resolveAgentConfig } from "../settings-loader";
import { buildTools } from "../tools";

export async function renderInstruccionMaestraDoc(env: Env): Promise<string> {
  const db = new Db(env.DB);
  const repo = new SettingsRepo(db);

  const toolNames = Object.keys(buildTools({ env, getConversationId: () => null }));
  const cfg = await resolveAgentConfig(env, toolNames);
  const disabledToolNames = toolNames.filter((n) => !cfg.enabledToolNames.includes(n));

  const overrideActive = (await repo.get(SETTING_KEYS.systemPromptOverride))?.trim();
  const rawLessons = (await repo.get(SETTING_KEYS.learnedLessons)) ?? "[]";
  const lessons: string[] = (() => {
    try {
      const parsed = JSON.parse(rawLessons);
      return Array.isArray(parsed) ? parsed.filter((l: unknown) => typeof l === "string") : [];
    } catch {
      return [];
    }
  })();
  const autonomyLevel = (await repo.get(SETTING_KEYS.autonomyLevel)) ?? "manual";
  const language = (await repo.get(SETTING_KEYS.botLanguage)) ?? env.BOT_LANGUAGE;

  const historyRows = await db.all<HistoryRow>(
    "SELECT key, old_value, new_value, actor, changed_at FROM settings_history ORDER BY changed_at ASC",
  );

  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16);

  const avisos = overrideActive
    ? `## ⚠️ Avisos\n- \`system_prompt_override\` ACTIVO: el prompt generado y las ${lessons.length} lecciones del flywheel se están ignorando.\n\n`
    : "";

  const estadoActual = [
    "## Estado actual",
    `Modelo: ${cfg.modelOverride} · Idioma: ${language} · Autonomía: ${autonomyLevel}`,
    `Tools habilitadas: ${cfg.enabledToolNames.join(", ") || "(ninguna)"}`,
    `Tools deshabilitadas: ${disabledToolNames.join(", ") || "(ninguna)"}`,
  ].join("\n");

  const promptEfectivo = `## Prompt efectivo\n\`\`\`\n${cfg.systemPrompt}\n\`\`\``;

  const leccionesSection = `## Lecciones aprendidas (${lessons.length} activas)\n${
    lessons.length > 0 ? lessons.map((l, i) => `${i + 1}. ${l}`).join("\n") : "(ninguna)"
  }`;

  const changelog = renderChangelog(historyRows);

  return [
    `# Instrucción Maestra — ${env.BOT_NAME}`,
    `> Generado: ${generatedAt} · ${env.BOT_NAME}`,
    "",
    avisos,
    estadoActual,
    "",
    promptEfectivo,
    "",
    leccionesSection,
    "",
    changelog,
  ].filter((s) => s !== "").join("\n");
}
```

Task 4 already imports `SETTING_KEYS` from `"../db/settings"` at the top of `src/admin/instruccion-maestra.ts` — extend that same import line to also bring in `SettingsRepo` instead of adding a second import line:

```typescript
import { SettingsRepo, SETTING_KEYS } from "../db/settings";
```

- [ ] **Step 4: Wire the route**

In `src/admin/routes.ts`, add the import near the other view imports (after line 39's `KbDocsRepo` import, alphabetical-ish placement isn't enforced elsewhere in this file, so just add it near the top import block):

```typescript
import { renderInstruccionMaestraDoc } from "./instruccion-maestra";
```

Add the route near the other `adminApp.get(...)` text-response routes — right after the `/leads/export.csv` route (`src/admin/routes.ts:516-524`):

```typescript
adminApp.get("/instruccion-maestra.md", async (c) => {
  const doc = await renderInstruccionMaestraDoc(c.env);
  return new Response(doc, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
});
```

No auth code needed here — the blanket `adminApp.use("*", ...)` guard (`src/admin/routes.ts:76-79`) already covers every route in this file, including this one.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/admin/instruccion-maestra-route.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: Both clean/passing.

- [ ] **Step 7: Commit**

```bash
cd ~/Dev/forja
git add src/admin/instruccion-maestra.ts src/admin/routes.ts test/admin/instruccion-maestra-route.test.ts
git commit -m "feat(admin): endpoint GET /admin/instruccion-maestra.md"
```

---

### Task 6: 503 on partial failure (error handling)

**Files:**
- Modify: `src/admin/routes.ts` (wrap the route handler)
- Test: `test/admin/instruccion-maestra-route.test.ts` (extend)

**Interfaces:**
- Consumes: `renderInstruccionMaestraDoc` from Task 5.
- Produces: nothing new — behavioral change only (the route returns 503 with a plain-text body instead of throwing/500 on internal failure).

- [ ] **Step 1: Write the failing test**

Add to `test/admin/instruccion-maestra-route.test.ts`, inside the existing `describe`:

```typescript
  it("returns 503 instead of a partial document when composition fails", async () => {
    // Force a failure inside renderInstruccionMaestraDoc by breaking the DB
    // binding after setup — simplest reliable way without a full mock:
    const brokenEnv = { ...env, DB: undefined } as unknown as Env;
    const res = await adminApp.request("/instruccion-maestra.md", { headers: AUTH }, brokenEnv);
    expect(res.status).toBe(503);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/admin/instruccion-maestra-route.test.ts`
Expected: FAIL — the handler throws an unhandled error (test runner reports it as a thrown exception or Hono's default 500), not a clean 503.

- [ ] **Step 3: Wrap the route handler**

In `src/admin/routes.ts`, replace the route added in Task 5:

```typescript
adminApp.get("/instruccion-maestra.md", async (c) => {
  try {
    const doc = await renderInstruccionMaestraDoc(c.env);
    return new Response(doc, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
  } catch (e) {
    console.error("instruccion-maestra.md:", e);
    return c.text("No se pudo generar la instrucción maestra — intentá de nuevo.", 503);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/admin/instruccion-maestra-route.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd ~/Dev/forja
git add src/admin/routes.ts test/admin/instruccion-maestra-route.test.ts
git commit -m "fix(admin): 503 en vez de documento parcial si falla la composición"
```

---

### Task 7: Nightly purge of old `settings_history` rows

**Files:**
- Create: `src/crons/purgeOldSettingsHistory.ts`
- Modify: `src/index.ts` (wire into the scheduled handler)
- Test: `test/crons/purgeOldSettingsHistory.test.ts`

**Interfaces:**
- Produces: `export const SETTINGS_HISTORY_RETENTION_DAYS = 365` and `async function purgeOldSettingsHistory(env: Env, now?: number): Promise<number>` in `src/crons/purgeOldSettingsHistory.ts` — mirrors `purgeOldMessages`'s exact shape (`src/crons/purgeOldMessages.ts`).

- [ ] **Step 1: Write the failing test**

Create `test/crons/purgeOldSettingsHistory.test.ts` (mirrors `test/crons/purgeOldMessages.test.ts`):

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { Db } from "../../src/db/client";
import { purgeOldSettingsHistory, SETTINGS_HISTORY_RETENTION_DAYS } from "../../src/crons/purgeOldSettingsHistory";

let env: any;
let db: Db;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  const mf = await createTestMiniflare();
  const d1 = await mf.getD1Database("DB");
  env = { DB: d1 };
  db = new Db(d1 as any);
});

async function insertAged(key: string, changedAt: number) {
  await db.run(
    `INSERT INTO settings_history (key, old_value, new_value, actor, changed_at) VALUES (?, NULL, 'x', 'system', ?)`,
    [key, changedAt],
  );
}

describe("purgeOldSettingsHistory cron", () => {
  it("deletes history rows older than the retention window but keeps recent ones", async () => {
    const now = 1_000 * DAY;
    await insertAged("old-1", now - (SETTINGS_HISTORY_RETENTION_DAYS + 5) * DAY);
    await insertAged("old-2", now - (SETTINGS_HISTORY_RETENTION_DAYS + 1) * DAY);
    await insertAged("recent", now - 3 * DAY);

    const deleted = await purgeOldSettingsHistory(env, now);
    expect(deleted).toBe(2);

    const remaining = await db.all<{ key: string }>("SELECT key FROM settings_history");
    expect(remaining).toEqual([{ key: "recent" }]);
  });

  it("deletes nothing when all rows are within the window", async () => {
    const now = 1_000 * DAY;
    await insertAged("a", now - 1 * DAY);
    const deleted = await purgeOldSettingsHistory(env, now);
    expect(deleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/crons/purgeOldSettingsHistory.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the cron**

Create `src/crons/purgeOldSettingsHistory.ts` (mirrors `src/crons/purgeOldMessages.ts` exactly):

```typescript
import type { Env } from "../env";
import { Db } from "../db/client";

/** settings_history rows older than this are purged by the daily cron. */
export const SETTINGS_HISTORY_RETENTION_DAYS = 365;

/**
 * Daily cron: delete settings_history rows older than the retention window.
 * `settings` itself (current values) is never touched.
 *
 * `now` is injectable for tests; defaults to the current time.
 */
export async function purgeOldSettingsHistory(env: Env, now: number = Date.now()): Promise<number> {
  const cutoff = now - SETTINGS_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const db = new Db(env.DB);
  const res = await db.run("DELETE FROM settings_history WHERE changed_at < ?", [cutoff]);
  const deleted = res.meta.changes ?? 0;
  console.log(`[cron purgeOldSettingsHistory] deleted ${deleted} rows older than ${SETTINGS_HISTORY_RETENTION_DAYS}d`);
  return deleted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/crons/purgeOldSettingsHistory.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire it into the nightly scheduled handler**

In `src/index.ts`, add the import near the existing `purgeOldMessages` import:

```typescript
import { purgeOldSettingsHistory } from "./crons/purgeOldSettingsHistory";
```

In the `scheduled()` handler, right after the existing `await purgeOldMessages(env);` line (`src/index.ts`, inside the `if (event.cron && event.cron !== "0 3 * * *") return;` guard block, same nightly-only section):

```typescript
    // Daily cron (wrangler.toml: "0 3 * * *") — purge messages older than 90 days.
    await purgeOldMessages(env);
    // Daily cron: purge settings_history rows older than 365 days.
    await purgeOldSettingsHistory(env);
```

- [ ] **Step 6: Typecheck and full suite**

Run: `pnpm typecheck && pnpm test`
Expected: Both clean.

- [ ] **Step 7: Commit**

```bash
cd ~/Dev/forja
git add src/crons/purgeOldSettingsHistory.ts src/index.ts test/crons/purgeOldSettingsHistory.test.ts
git commit -m "feat(cron): purga nocturna de settings_history a 365 días"
```

---

### Task 8: `pnpm prompt:sync` script

**Files:**
- Create: `scripts/prompt-sync.ts`
- Modify: `package.json` (add script entry)

**Interfaces:**
- Consumes: `GET /admin/instruccion-maestra.md` route from Task 5/6 (must return 200 + `text/markdown` on success).
- Produces: nothing consumed by other tasks — this is the final leaf of the plan.

This task is a standalone Node script, not part of the Cloudflare Worker bundle, so it isn't covered by the Miniflare-based vitest suite. Verify it manually (Step 4) against the real deployed bot instead of writing an automated test — matches how `scripts/eval-bot-live.ts` (an existing live-verification script in this repo) is handled.

- [ ] **Step 1: Write the script**

Create `scripts/prompt-sync.ts`:

```typescript
/**
 * Baja GET /admin/instruccion-maestra.md del bot desplegado y lo escribe en
 * FORJA/_context/instruccion-maestra.md (OneDrive, fuera de este repo — ver
 * docs/superpowers/specs/2026-08-01-instruccion-maestra-viva-design.md).
 *
 * Requiere en el entorno:
 *   DASHBOARD_PASSWORD   — la misma password del panel admin (Basic Auth)
 *   BOT_BASE_URL          — opcional, default al Worker desplegado de BIRevX
 *   PROMPT_SYNC_TARGET     — opcional, default a la ruta de OneDrive de este equipo
 *
 * Uso: pnpm prompt:sync
 */
import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BOT_BASE_URL = process.env.BOT_BASE_URL ?? "https://birevx-support-bot.victor-m-426.workers.dev";
const DEFAULT_TARGET =
  "/Users/mvico/Library/CloudStorage/OneDrive-BSEBI/08_Claude/Projects/CODE/FORJA/_context/instruccion-maestra.md";
const TARGET = process.env.PROMPT_SYNC_TARGET ?? DEFAULT_TARGET;

async function main() {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    console.error("Falta DASHBOARD_PASSWORD en el entorno.");
    process.exit(1);
  }

  const auth = Buffer.from(`admin:${password}`, "utf-8").toString("base64");
  const res = await fetch(`${BOT_BASE_URL}/admin/instruccion-maestra.md`, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (res.status !== 200) {
    console.error(`Respuesta ${res.status} — no se actualiza el archivo local (se conserva la versión previa).`);
    process.exit(1);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/markdown")) {
    console.error(`Content-Type inesperado (${contentType}) — no se actualiza el archivo local.`);
    process.exit(1);
  }

  const body = await res.text();

  const tmpPath = path.join(tmpdir(), `instruccion-maestra-${Date.now()}.md`);
  writeFileSync(tmpPath, body, "utf-8");
  try {
    renameSync(tmpPath, TARGET);
  } catch (e) {
    // rename cross-device (tmp en otro filesystem que OneDrive) — fallback a copy+delete.
    writeFileSync(TARGET, body, "utf-8");
    unlinkSync(tmpPath);
  }

  console.log(`✅ Instrucción maestra sincronizada: ${TARGET}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Add the package.json script entry**

In `package.json`, in the `"scripts"` block, add after `"eval": "tsx scripts/eval-bot-live.ts"`:

```json
    "prompt:sync": "tsx scripts/prompt-sync.ts"
```

(Remember to add the preceding comma to the `"eval"` line since it's no longer the last entry.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean (the script is plain Node/tsx, not part of the Worker bundle, but must still typecheck if `tsconfig.json` includes `scripts/`).

- [ ] **Step 4: Manual verification against the real deployed bot**

Run:
```bash
DASHBOARD_PASSWORD=<la password real del panel admin> pnpm prompt:sync
```
Expected: prints `✅ Instrucción maestra sincronizada: <ruta>`, and the file exists at `FORJA/_context/instruccion-maestra.md` with the expected sections (`# Instrucción Maestra`, `## Estado actual`, `## Prompt efectivo`, `## Lecciones aprendidas`, `## Changelog`).

Also verify the failure path: run once with a wrong password and confirm it prints the 401/503 error and does **not** overwrite the existing good file (`git diff` — actually this file isn't in git, so just re-read it and confirm content is unchanged from the successful run).

- [ ] **Step 5: Commit**

```bash
cd ~/Dev/forja
git add scripts/prompt-sync.ts package.json
git commit -m "feat(scripts): pnpm prompt:sync — baja la instrucción maestra a OneDrive"
```

---

### Task 9: Apply the migration to the live D1 database and deploy

**Files:** none (operational task — no code changes)

**Interfaces:** none

This task follows the exact order-of-operations discipline documented in `docs/canales/ycloud.md` for the YCloud cutover: **schema change before code that depends on it**, applied to the *live* database, not just the local test one (Miniflare already has it via `createTestMiniflare()`'s automatic `schema.sql` load, but that's a fresh in-memory DB per test — it says nothing about the real D1 database backing the deployed bot).

- [ ] **Step 0: Merge this branch into `~/Dev/forja` main first**

`~/Dev/forja` (the main checkout, NOT the worktree this plan was executed
from) is still on `main` without the `settings_history` table in its local
`schema.sql` — until `feat/instruccion-maestra-viva` is merged there. If
Step 1's `pnpm db:apply:remote` is run literally from `~/Dev/forja` before
merging, it reads the OLD `schema.sql`, "succeeds" without creating anything,
and the subsequent deploy would ship code that depends on a table that was
never created. Merge `feat/instruccion-maestra-viva` into `main` in
`~/Dev/forja` first — or, if that's not yet possible, run Step 1 from this
worktree (`/Users/mvico/Dev/forja-instruccion-maestra`) instead of from
`~/Dev/forja`.

- [ ] **Step 1: Apply the migration to the live D1 database**

Run: `cd ~/Dev/forja && pnpm db:apply:remote`
Expected: no errors — `settings_history` table and its index are created (idempotent `CREATE TABLE IF NOT EXISTS`, safe to re-run).

Verify the table was actually created (don't trust a silent "success" — see Step 0):
```bash
wrangler d1 execute horizontes_bot_db --remote --command "SELECT name FROM sqlite_master WHERE name='settings_history'"
```
Expected: one row with `name = settings_history`. If the result is empty, Step 0 was skipped or the merge didn't happen — stop here, do not proceed to Step 2 (deploy).

- [ ] **Step 2: Deploy**

Run: `cd ~/Dev/forja && pnpm deploy`
Expected: deploy succeeds, `Current Version ID` printed.

- [ ] **Step 3: Smoke-test the live endpoint**

Run:
```bash
curl -s -u "admin:<DASHBOARD_PASSWORD>" https://birevx-support-bot.victor-m-426.workers.dev/admin/instruccion-maestra.md | head -30
```
Expected: 200, markdown starting with `# Instrucción Maestra`.

- [ ] **Step 4: Run the real sync (Task 8, Step 4) against production**

Confirms the full pipeline end-to-end: live D1 → endpoint → script → file in `FORJA/_context/`.

- [ ] **Step 5: Update project memory**

Update `FORJA/_context/status.md` and `_context/memory.md` (per this OneDrive project's own session ritual in `CLAUDE.md`) to note that the instrucción-maestra auditoría feature is live, and that `pnpm prompt:sync` is the command to refresh the local `.md` snapshot going forward. Present the update block for the user's approval before writing, per the existing session-closing ritual — don't write it unprompted.
