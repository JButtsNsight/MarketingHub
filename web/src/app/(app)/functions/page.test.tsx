import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  requireMarketingUser: vi.fn(),
  order: vi.fn(),
  chainCalls: [] as Array<{ schema: string; table: string; columns: string }>,
  getUserClientCalls: [] as unknown[],
}));

vi.mock("@/lib/requireMarketingUser", () => ({
  requireMarketingUser: h.requireMarketingUser,
}));
vi.mock("@/lib/supabase", () => ({
  getUserClient: async (user: unknown) => {
    h.getUserClientCalls.push(user);
    return {
      schema: (schema: string) => ({
        from: (table: string) => ({
          select: (columns: string) => {
            h.chainCalls.push({ schema, table, columns });
            return { order: h.order };
          },
        }),
      }),
    };
  },
}));

import FunctionsPage from "./page";

const ROW = {
  name: "hello",
  version: "1",
  updated_at: "2026-08-08T12:00:00Z",
  deployed_at: "2026-08-08T12:05:00Z",
  notes: null,
  source: 'serve(() => new Response("hi"))',
};

const AMY = { email: "amy@nsight.example", name: "Amy", groups: ["marketing"] };

describe("functions/page.tsx (server component)", () => {
  beforeEach(() => {
    h.requireMarketingUser.mockReset().mockResolvedValue(AMY);
    h.order.mockReset().mockResolvedValue({ data: [ROW], error: null });
    h.chainCalls.length = 0;
    h.getUserClientCalls.length = 0;
  });

  test("enforces the marketing gate and preloads the registry as the user", async () => {
    render(await FunctionsPage());

    expect(h.requireMarketingUser).toHaveBeenCalled();
    // Wave-4 identity threading: the registry read runs as the viewer.
    expect(h.getUserClientCalls).toEqual([AMY]);
    expect(h.chainCalls).toEqual([
      {
        schema: "marketinghub",
        table: "edge_functions",
        columns: "name, version, updated_at, deployed_at, notes, source",
      },
    ]);
    // level 1 = the PageHeader; the registry Section reuses the name at h2.
    expect(
      screen.getByRole("heading", { name: "Edge Functions", level: 1 }),
    ).toBeInTheDocument();
    // role=cell scopes to the registry table (the invoke <option> also says "hello").
    expect(screen.getByRole("cell", { name: "hello" })).toBeInTheDocument();
  });

  test("a failing registry read renders the honest empty console, not a 500", async () => {
    h.order.mockRejectedValue(new Error("relation does not exist"));
    render(await FunctionsPage());
    expect(
      screen.getByText(/No edge functions registered yet/),
    ).toBeInTheDocument();
  });

  test("a PostgREST error object (table not migrated) also renders empty", async () => {
    h.order.mockResolvedValue({
      data: null,
      error: { message: 'relation "marketinghub.edge_functions" does not exist' },
    });
    render(await FunctionsPage());
    expect(
      screen.getByText(/No edge functions registered yet/),
    ).toBeInTheDocument();
  });
});
