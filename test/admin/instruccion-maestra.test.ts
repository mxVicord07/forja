import { describe, it, expect } from "vitest";
import { renderChangelog, renderChangelogEntry, ALLOWED_KEYS, type HistoryRow } from "../../src/admin/instruccion-maestra";
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

  it("hides llm_api_key values (outside the allowlist)", () => {
    const line = renderChangelogEntry(
      row({ key: SETTING_KEYS.llmApiKey, old_value: "sk-old-secret", new_value: "sk-new-secret" }),
    );
    expect(line).not.toContain("sk-old-secret");
    expect(line).not.toContain("sk-new-secret");
    expect(line).toContain("(valor oculto)");
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

describe("ALLOWED_KEYS", () => {
  it("does not include llm_api_key", () => {
    expect(ALLOWED_KEYS).not.toContain(SETTING_KEYS.llmApiKey);
  });

  it("includes ordinary settings like tone", () => {
    expect(ALLOWED_KEYS).toContain(SETTING_KEYS.tone);
  });
});

describe("renderChangelogEntry — allowlist", () => {
  it("hides the value for a key outside ALLOWED_KEYS (e.g. a learn:* capture)", () => {
    const line = renderChangelogEntry(
      row({
        key: "learn:whatsapp:capture:text",
        old_value: null,
        new_value: JSON.stringify({ phone: "+52123456789", text: "hola, quiero comprar" }),
        actor: "system",
      }),
    );
    expect(line).toContain("(valor oculto)");
    expect(line).not.toContain("+52123456789");
    expect(line).not.toContain("hola, quiero comprar");
  });

  it("still shows key/actor/timestamp metadata for a hidden-value entry", () => {
    const line = renderChangelogEntry(
      row({ key: "map:whatsapp", old_value: null, new_value: "{}", actor: "system" }),
    );
    expect(line).toContain("map:whatsapp");
    expect(line).toContain("system");
  });
});
