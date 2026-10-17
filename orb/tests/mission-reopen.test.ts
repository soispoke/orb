import { afterEach, expect, it, vi } from "vitest";
import { reopenMission } from "../src/api";

afterEach(() => vi.unstubAllGlobals());

it.each(["completed", "failed", "interrupted", "acknowledged"])("reopens %s without launching a run", async status => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "mission", status })))
    .mockResolvedValueOnce(new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  await reopenMission("mission");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toMatch(/\/missions\/mission\/status$/);
  expect(fetcher.mock.calls[1][1].method).toBe("POST");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ status: "paused" });
});

it.each([
  { status: "active" },
  { status: "completed", execution: { state: "running" } },
])("refuses to reopen a live mission: %j", async mission => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ id: "mission", ...mission }));
  vi.stubGlobal("fetch", fetcher);
  await expect(reopenMission("mission")).rejects.toThrow(/no longer finished/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("pins the exact title before restoring, without launching work", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ id: "mission", status: "acknowledged", title: "Kohaku review" }))
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await reopenMission("mission");
  expect(fetcher.mock.calls.slice(1).map(([url, init]) => [url.split("/mission/")[1], JSON.parse(init.body)]))
    .toEqual([["title", {title: "Kohaku review"}], ["status", {status: "paused"}]]);
});

it("does not restore when preserving the title fails", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ id: "mission", status: "acknowledged", title: "Keep me" }))
    .mockResolvedValueOnce(new Response("Title save failed", {status: 500}));
  vi.stubGlobal("fetch", fetcher);
  await expect(reopenMission("mission")).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][0]).toMatch(/\/title$/);
});
