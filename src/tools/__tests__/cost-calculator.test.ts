import { describe, it, expect, vi, afterEach } from "vitest";
import { registerCostCalculatorTool } from "../cost-calculator.js";

function getHandler() {
  let handler: (a: any) => Promise<any>;
  const fake = {
    registerTool: (_n: string, _c: unknown, h: (a: any) => Promise<any>) => {
      handler = h;
    },
  };
  registerCostCalculatorTool(fake as never);
  return handler!;
}

afterEach(() => vi.restoreAllMocks());

describe("varity_cost_calculator (thin client of gateway /api/pricing)", () => {
  it("calls the gateway pricing endpoint (single source of truth) and maps the result", async () => {
    const gatewayPayload = {
      varityMonthly: 6,
      varityIsFlat: true,
      mode: "dynamic",
      alwaysCheaper: true,
      competitors: [
        { id: "render", label: "Render", atLaunch: 14, atTraction: 292, source: "x" },
      ],
      best: { label: "Render", pct: 57 },
      biggestSpike: { label: "Render", from: 14, to: 292 },
      aha: "flat forever; competitors spike",
      note: "fixed hardware pricing",
      sources: {},
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => gatewayPayload });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getHandler()({ app_profile: "web-app-db", has_database: true });

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/pricing");
    expect(calledUrl).toContain("profile=web-app-db");
    expect(calledUrl).toContain("has_db=true");

    const data = JSON.parse(res.content[0].text).data;
    expect(data.varityMonthly).toBe(6);
    expect(data.alwaysCheaper).toBe(true);
    // No duplicated pricing math in the MCP — it just relays the gateway.
    expect(data.source).toMatch(/single source of truth/i);
  });

  it("uses subdomain (real mode) when provided, not profile", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ varityMonthly: 9, competitors: [], aha: "x" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await getHandler()({ subdomain: "my-app" });
    expect(fetchMock.mock.calls[0][0]).toContain("subdomain=my-app");
    expect(fetchMock.mock.calls[0][0]).not.toContain("profile=");
  });

  it("returns a clean error (never a fabricated price) when the gateway is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const res = await getHandler()({ app_profile: "web-app" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error.code).toBe(
      "pricing_unreachable"
    );
  });
});
