// Review-only config: serves the full Orb UI against an in-memory fake API.
import { defineConfig, mergeConfig, type Plugin } from "vite";
import base from "./vite.config";

const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const longReply = `## Summary

I traced the regression to the **virtualized transcript**: when a turn grows while the user is scrolled up, the anchor is recomputed from the stale height.

### Changes
1. Measure turns with \`ResizeObserver\` before re-anchoring.
2. Keep the pinned-bottom state when a new turn arrives.
3. Added a browser test covering WebKit.

\`\`\`ts
const anchor = rows.findLast(r => r.top <= scrollTop);
if (pinned) scroller.scrollTop = scroller.scrollHeight;
\`\`\`

| Check | Result |
| --- | --- |
| Unit | 1,328 passed |
| Browser | 312 passed |

Let me know if you want me to also cover the Inbox peek drawer.`;

const missions: any[] = [
  { id: "m1", title: "Fix transcript scroll jump on new turns", status: "completed", project: "orb", backend: "claudecode", model: "claude-opus-5-5", tags: [], created_at: iso(300), updated_at: iso(12) },
  { id: "m2", title: "Investigate flaky WebKit overlay test", status: "active", project: "orb", backend: "codex", model: "gpt-6", tags: [], created_at: iso(90), updated_at: iso(1) },
  { id: "m3", title: "Which signature scheme should the bound use?", status: "awaiting_user", project: "siggolf", backend: "claudecode", tags: [], created_at: iso(600), updated_at: iso(40) },
  { id: "m4", title: "Lean build failed on stage 4 lemma", status: "failed", project: "siggolf", backend: "opencode", tags: [], created_at: iso(2000), updated_at: iso(1500) },
  { id: "m5", title: "A very long conversation title that keeps going to check truncation in the sidebar and headers", status: "completed", project: "hardness", backend: "claudecode", tags: [], created_at: iso(5000), updated_at: iso(4000) },
];
const events = (id: string) => {
  const m = missions.find(x => x.id === id);
  const t = m?.created_at ?? iso(10);
  const list: any[] = [
    { event_type: "user_message", timestamp: t, content: "When a new turn arrives while I'm scrolled up, the transcript jumps. Can you fix it and add a test?" },
    { event_type: "tool_call", timestamp: t, tool_call_id: "c1", tool_name: "Read", content: JSON.stringify({ file_path: "orb/src/VirtualTurns.tsx" }) },
    { event_type: "tool_result", timestamp: t, tool_call_id: "c1", tool_name: "Read", content: "ok" },
    { event_type: "tool_call", timestamp: t, tool_call_id: "c2", tool_name: "Edit", content: JSON.stringify({ file_path: "orb/src/VirtualTurns.tsx" }) },
    { event_type: "tool_result", timestamp: t, tool_call_id: "c2", tool_name: "Edit", content: "ok" },
    { event_type: "tool_call", timestamp: t, tool_call_id: "c3", tool_name: "Bash", content: JSON.stringify({ command: "pnpm exec vitest run tests/virtual-turns.test.ts" }) },
    { event_type: "tool_result", timestamp: t, tool_call_id: "c3", tool_name: "Bash", content: "✓ 14 passed" },
    { event_type: "assistant_message", timestamp: m?.updated_at ?? t, content: longReply },
  ];
  if (m?.status === "active") list.push({ event_type: "user_message", timestamp: iso(1), content: "Also check Safari please." });
  return list.map((e, i) => ({ id: i + 1, sequence: i + 1, ...e }));
};

function fakeApi(): Plugin {
  return {
    name: "orb-fake-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        const url = new URL(req.url, "http://x");
        const p = url.pathname;
        const send = (json: unknown, headers: Record<string, string> = {}) => {
          res.setHeader("Content-Type", "application/json");
          for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
          res.end(JSON.stringify(json));
        };
        if (req.method !== "GET") return send({});
        if (p === "/api/projects") return send({ projects: [{ slug: "orb", title: "Orb", color: "blue" }, { slug: "siggolf", title: "SigGolf", color: "green" }, { slug: "hardness", title: "HardnessVault" }] });
        if (p === "/api/control/missions") return send(missions);
        const mm = p.match(/^\/api\/control\/missions\/([^/]+)(\/.*)?$/);
        if (mm) {
          const m = missions.find(x => x.id === mm[1]);
          const rest = mm[2] ?? "";
          if (!rest) return m ? send(m) : (res.statusCode = 404, res.end());
          if (rest === "/events") {
            const all = events(mm[1]);
            const since = url.searchParams.get("since_seq"), before = url.searchParams.get("before_seq"), types = url.searchParams.get("types")?.split(",");
            let ev = all.filter(e => (since === null || e.sequence > +since) && (before === null || e.sequence < +before) && (!types || types.includes(e.event_type)));
            const h: Record<string, string> = { "X-Orb-Events-Protocol": "1", "X-Has-More": "false", "X-Max-Sequence": String(all.length) };
            if (ev.length) { h["X-Page-Max-Sequence"] = String(ev[ev.length - 1].sequence); h["X-Next-Cursor"] = String(since === null ? ev[0].sequence : ev[ev.length - 1].sequence); }
            return send(ev, h);
          }
          if (rest === "/queue") return send([]);
        }
        if (p.endsWith("/manifest")) return send({ revision: 1, entries: {} });
        if (p.endsWith("/files")) return send({ entries: [] });
        if (p.endsWith("/crons")) return send({ jobs: [] });
        if (p.endsWith("/controller")) return send({ job: null, runs: [] });
        console.log("[fake-api] default []", p);
        return send([]);
      });
    },
  };
}

export default mergeConfig(base, defineConfig({
  plugins: [fakeApi()],
  server: { port: 1440, strictPort: true },
}));
