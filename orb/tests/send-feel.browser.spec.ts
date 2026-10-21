import { expect, test, type Page } from "@playwright/test";

// Frame-by-frame record of what the user sees while a follow-up is sent:
// every copy of the sent message, its position and identity, the dock under
// the transcript, the composer, and the scroll position.
const MISSION = "send-feel";
const answer = "The audit finished. All checks pass and the numbers are recorded in the report. ".repeat(4);

type Frame = { t: number; bubbles: { id: number; y: number; cls: string; opacity: string }[]; dock: string[]; dockHeight: number; composerHeight: number; draft: number; gap: number; notice: string };

async function run(page: Page, opts: { backend: string; active: boolean; postDelay: number; sendNowDelay: number; echoAfter: number; queuedEcho: boolean }) {
  const mission = { id: MISSION, project: "test", title: "Send feel", status: opts.active ? "active" : "awaiting_user", history: [], backend: opts.backend, created_at: "", updated_at: "" };
  const events = Array.from({ length: 6 }, (_, i) => [
    { id: `u${i}`, event_id: `u${i}`, sequence: i * 2 + 1, event_type: "user_message", content: `Request ${i}`, timestamp: "" },
    { id: `a${i}`, event_id: `a${i}`, sequence: i * 2 + 2, event_type: "assistant_message", content: answer, timestamp: "" },
  ]).flat();
  await page.addInitScript(({ text }) => {
    localStorage.setItem("orb.apiUrl", location.origin);
    localStorage.setItem("orb.jwt", "test");
    localStorage.setItem("orb-theme", "dark");
    const ids = new WeakMap<Element, number>(); let next = 0;
    (window as any).frames_ = [];
    const sample = () => {
      const start = (window as any).sendStart;
      if (start) {
        const bubbles = Array.from(document.querySelectorAll(".scroll .user")).filter(el => el.textContent?.includes(text)).map(el => {
          if (!ids.has(el)) ids.set(el, ++next);
          return { id: ids.get(el)!, y: Math.round(el.getBoundingClientRect().y), cls: el.className, opacity: getComputedStyle(el).opacity };
        });
        const scroll = document.querySelector(".scroll") as HTMLElement | null;
        const composer = document.querySelector(".composer") as HTMLElement | null;
        const dockEls = Array.from(document.querySelectorAll(".agent-wait-status, [aria-label='Queued messages'], .queued-messages, .remote-queue")) as HTMLElement[];
        const dock = dockEls.map(el => (el.className + ": " + el.textContent).slice(0, 90));
        (window as any).frames_.push({
          t: Math.round(performance.now() - start), bubbles, dock,
          dockHeight: Math.round(dockEls.reduce((h, el) => h + el.getBoundingClientRect().height, 0)),
          composerHeight: Math.round(composer?.getBoundingClientRect().height ?? 0),
          draft: (document.querySelector(".composer textarea") as HTMLTextAreaElement | null)?.value.length ?? -1,
          gap: scroll ? Math.round(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) : -1,
          notice: document.querySelector(".agent-wait-status")?.textContent ?? "",
          below: (() => { const b = Array.from(document.querySelectorAll(".scroll .user")).find(el => el.textContent?.includes(text)) as HTMLElement | undefined; if (!b) return null; const bb = b.getBoundingClientRect(); const out: string[] = [`bubbleH=${Math.round(bb.height)}`]; const row = b.closest('[data-virtual-transcript] > *') as HTMLElement | null; if (row) out.push(`row:${Math.round(row.getBoundingClientRect().height)}`); let el: Element | null = row ?? b; while (el && (el = el.nextElementSibling)) out.push(`${el.className.toString().slice(0, 24)}:${Math.round(el.getBoundingClientRect().height)}`); const vt = document.querySelector('[data-virtual-transcript]'); let c: Element | null = vt; while (c && (c = c.nextElementSibling)) out.push(`col>${c.className.toString().slice(0, 24)}:${Math.round(c.getBoundingClientRect().height)}`); const col = document.querySelector('.scroll .col') as HTMLElement; out.push(`colPadB=${getComputedStyle(col).paddingBottom}`); const dock = document.querySelector('.dock .col') as HTMLElement | null; if (dock) out.push('DOCK[' + Array.from(dock.children).map(c => `${c.tagName.toLowerCase()}.${c.className.toString().slice(0, 30)}:${Math.round(c.getBoundingClientRect().height)}`).join(', ') + ']'); out.push('ERR=' + (document.querySelector('.dock .error-notice')?.textContent ?? '').slice(0,160)); out.push('BUBBLE=' + b.innerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '').slice(0, 260)); return out.join(' '); })(),
          probe: (() => { const el = Array.from(document.querySelectorAll(".agent-wait-status")).find(e => e.textContent?.includes("Waiting for")) as HTMLElement | undefined; if (!el) return null; const cs = getComputedStyle(el); const col = el.closest(".col") as HTMLElement | null; const parent = el.parentElement!; return { html: el.outerHTML.slice(0, 400), next: (el.nextElementSibling?.outerHTML ?? "").slice(0, 200), w: Math.round(el.getBoundingClientRect().width), colW: Math.round(col?.getBoundingClientRect().width ?? 0), h: Math.round(el.getBoundingClientRect().height), grow: cs.flexGrow, display: cs.display, parentCls: parent.className.slice(0, 40), parentDisplay: getComputedStyle(parent).display, colH: Math.round(col?.getBoundingClientRect().height ?? 0), prev: (el.previousElementSibling?.className ?? '').slice(0, 40), prevH: Math.round(el.previousElementSibling?.getBoundingClientRect().height ?? 0), scrollH: (document.querySelector('.scroll') as HTMLElement)?.scrollHeight }; })(),
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input).includes("/api/control/stream?mission=")) {
        return new Response(new ReadableStream({ start(controller) {
          (window as any).emit = (type: string, data: unknown) => controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return originalFetch(input, init);
    };
  }, { text: "Please also check the final estimate" });
  const queued: { id: string; content: string; source: string; mission_id: string }[] = [];
  let sentId = "";
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/events")) {
      const q = new URL(route.request().url()).searchParams, since = q.get("since_seq"), before = q.get("before_seq");
      const rows = events.filter(e => (since === null || e.sequence > +since) && (before === null || e.sequence < +before));
      const headers: Record<string, string> = { "X-Orb-Events-Protocol": "1", "X-Has-More": "false", "X-Max-Sequence": String(events.length) };
      if (rows.length) { headers["X-Page-Max-Sequence"] = String(rows.at(-1)!.sequence); headers["X-Next-Cursor"] = String(since === null ? rows[0].sequence : rows.at(-1)!.sequence); }
      return route.fulfill({ json: rows, headers });
    }
    if (path === "/api/control/stream") return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path.endsWith("/message")) {
      const body = route.request().postDataJSON(); sentId = body.client_message_id;
      await new Promise(r => setTimeout(r, opts.postDelay));
      if (opts.active) queued.push({ id: sentId, content: body.content, source: "remote-queue", mission_id: MISSION });
      // Core activates an idle mission when it admits the message.
      if (!opts.active) { mission.status = "active"; await page.evaluate(() => (window as any).emit("mission_status_changed", { mission_id: "send-feel", status: "active" })); }
      return route.fulfill({ json: { id: sentId, queued: opts.active } });
    }
    if (path.endsWith("/send-now")) {
      await new Promise(r => setTimeout(r, opts.sendNowDelay));
      const i = queued.findIndex(r => r.id === path.split("/").at(-2)); if (i >= 0) queued.splice(i, 1);
      return route.fulfill({ json: { ok: true, delivered: true } });
    }
    if (path.endsWith("/queue")) return route.fulfill({ json: queued });
    if (path.startsWith("/api/control/missions/")) return route.fulfill({ json: mission });
    const json = path === "/api/projects" ? { projects: [{ slug: "test", title: "Test" }] }
      : path === "/api/control/missions" ? [mission]
      : path === "/api/backends" ? [{ id: opts.backend, name: opts.backend }]
      : path === "/api/providers/backend-models" ? { backends: { [opts.backend]: [{ value: "model", label: "Model" }] } }
      : path === "/api/remote-nodes" ? { enabled: true, nodes: [] }
      : path.endsWith("/files") ? { entries: [] } : path.endsWith("/crons") ? { jobs: [] } : { job: null, runs: [] };
    await route.fulfill({ json });
  });
  await page.goto("/#");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: /Send feel/ }).click();
  await expect(page.locator(".st-text").last()).toBeVisible();
  await page.waitForTimeout(600);
  console.log('col children:', JSON.stringify(await page.evaluate(() => Array.from(document.querySelector('.scroll .col')!.children).map(el => `${el.tagName.toLowerCase()}.${el.className}${el.hasAttribute('data-virtual-transcript')?'[virtual]':''} h=${Math.round(el.getBoundingClientRect().height)}`))));
  const input = page.locator(".composer textarea");
  await input.click();
  await input.fill("Please also check the final estimate");
  await page.evaluate(() => { (window as any).sendStart = performance.now(); });
  await input.press("Enter");
  // The server echoes the delivered message, as Core does when the harness accepts it.
  await page.waitForTimeout(opts.echoAfter);
  await page.evaluate(([id, queuedEcho]) => (window as any).emit("user_message", { id, content: "Please also check the final estimate", queued: queuedEcho, mission_id: "send-feel" }), [sentId, opts.queuedEcho] as const);
  await page.waitForTimeout(400);
  if (!opts.active) await page.evaluate(() => (window as any).emit("text_delta", { bubble_id: "r1", content: "Checking the estimate now.", mission_id: "send-feel" }));
  await page.waitForTimeout(2500);
  return (await page.evaluate(() => (window as any).frames_)) as Frame[];
}

function check(name: string, frames: Frame[]) {
  const seen = frames.filter(f => f.bubbles.length);
  expect(seen.length, `${name}: the sent message never appeared`).toBeGreaterThan(0);
  expect(new Set(seen.flatMap(f => f.bubbles.map(b => b.id))).size, `${name}: the sent message was rebuilt`).toBe(1);
  expect(seen.filter(f => f.bubbles.length > 1).length, `${name}: duplicate copies of the sent message`).toBe(0);
  const drops: string[] = [];
  for (let i = 1; i < seen.length; i++) {
    const down = seen[i].bubbles[0].y - seen[i - 1].bubbles[0].y;
    if (down > 2) drops.push(`${seen[i].t}ms: dropped ${down}px`);
  }
  expect(drops, `${name}: the sent message moved down (content under it disappeared)`).toEqual([]);
  const working = seen.map(f => f.dock.some(d => d.includes("Waiting for") || d.includes("Working on")));
  const firstOn = working.indexOf(true), lastOn = working.lastIndexOf(true);
  expect(firstOn, `${name}: no working indicator after sending`).toBeGreaterThanOrEqual(0);
  expect(working.slice(firstOn, lastOn + 1).every(Boolean), `${name}: the working indicator blinked`).toBe(true);
  expect(new Set(seen.map(f => f.composerHeight)).size, `${name}: the composer changed height`).toBe(1);
}

function summarize(name: string, frames: Frame[]) {
  const lines: string[] = [];
  let prev: Frame | undefined;
  let lastBelow = '';
  for (const f of frames) { const b = (f as any).below; if (b && b !== lastBelow) { console.log('below', f.t, b); lastBelow = b; } }
  for (const f of frames) {
    const key = JSON.stringify([f.bubbles.map(b => [b.id, b.y, b.cls, b.opacity]), f.dock, f.dockHeight, f.composerHeight, f.draft, f.gap > 2 ? f.gap : 0]);
    const prevKey = prev && JSON.stringify([prev.bubbles.map(b => [b.id, b.y, b.cls, b.opacity]), prev.dock, prev.dockHeight, prev.composerHeight, prev.draft, prev.gap > 2 ? prev.gap : 0]);
    if (key !== prevKey) lines.push(`${String(f.t).padStart(5)}ms bubbles=${JSON.stringify(f.bubbles.map(b => `#${b.id}@${b.y}${b.cls.includes("queued") ? "(q)" : ""}${b.opacity !== "1" ? `(o${b.opacity})` : ""}`))} dockH=${f.dockHeight} composerH=${f.composerHeight} draft=${f.draft} gap=${f.gap} dock=${JSON.stringify(f.dock)}`);
    prev = f;
  }
  const ids = new Set(frames.flatMap(f => f.bubbles.map(b => b.id)));
  const dup = frames.filter(f => f.bubbles.length > 1).length;
  console.log(`\n=== ${name}: ${ids.size} distinct bubble element(s), ${dup} frame(s) with duplicates\n` + lines.join("\n"));
}

for (const backend of ["claudecode", "codex", "opencode", "antigravity"]) {
  test(`sending mid-run is steady (${backend})`, async ({ page }) => {
    const frames = await run(page, { backend, active: true, postDelay: 500, sendNowDelay: 300, echoAfter: 1500, queuedEcho: false });
    if (process.env.SEND_FEEL_LOG) summarize(`mid-run ${backend}`, frames);
    check(`mid-run ${backend}`, frames);
  });
  test(`sending in an idle chat is steady (${backend})`, async ({ page }) => {
    const frames = await run(page, { backend, active: false, postDelay: 500, sendNowDelay: 0, echoAfter: 900, queuedEcho: false });
    if (process.env.SEND_FEEL_LOG) summarize(`idle ${backend}`, frames);
    check(`idle ${backend}`, frames);
  });
}
