/**
 * Confirms POST /admin/config attributes owner-initiated panel writes to
 * settings_history with actor = "owner" (Task 3 of the instrucción-maestra
 * viva work: attribution of settings writes).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createTestMiniflare } from "../helpers/miniflareSetup";
import { adminApp } from "../../src/admin/routes";
import type { Env } from "../../src/env";

const PASSWORD = "secret123";

function basicAuthHeader(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  const b64 =
    typeof btoa === "function"
      ? btoa(raw)
      : Buffer.from(raw, "utf-8").toString("base64");
  return `Basic ${b64}`;
}

const AUTH = { Authorization: basicAuthHeader("admin", PASSWORD) };

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
      {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      env,
    );
    expect(res.status).toBeLessThan(400);
    const rows = await d1.prepare("SELECT actor FROM settings_history WHERE key = 'bot_name'").all();
    expect(rows.results[0]).toMatchObject({ actor: "owner" });
  });
});
