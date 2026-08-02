import { describe, it, expect, vi, afterEach } from "vitest";
import { checkAvailabilityTool } from "../../src/tools/checkAvailability";

afterEach(() => vi.restoreAllMocks());

const env = (over: any = {}) => ({ CALCOM_API_KEY: "cal_x", CALCOM_EVENT_TYPE_ID: "10", ...over }) as any;

describe("checkAvailabilityTool", () => {
  it("devuelve los horarios libres del día", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { "2026-07-20": [{ start: "2026-07-20T09:00:00Z" }, { start: "2026-07-20T10:00:00Z" }] } }),
          { status: 200 },
        ),
      ),
    );
    const tool = checkAvailabilityTool(env());
    const res = (await tool.execute!({ fecha: "2026-07-20" }, {} as any)) as any;
    expect(res.ok).toBe(true);
    expect(res.slots).toEqual(["2026-07-20T09:00:00Z", "2026-07-20T10:00:00Z"]);
  });

  it("error si Cal.com no está configurado", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = checkAvailabilityTool({} as any);
    const res = (await tool.execute!({ fecha: "2026-07-20" }, {} as any)) as any;
    expect(res.error).toBe("calcom_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resuelve el eventTypeId por servicio cuando hay mapa", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = checkAvailabilityTool(env({ CALCOM_EVENT_TYPES: '{"corte":10,"barba":20}' }));
    await tool.execute!({ fecha: "2026-07-20", servicio: "quiero barba" }, {} as any);
    expect(String((fetchMock.mock.calls as any)[0][0])).toContain("eventTypeId=20");
  });
});
