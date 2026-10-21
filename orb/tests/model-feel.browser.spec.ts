import { expect, test, type Page } from "@playwright/test";

// Frame-by-frame record of changing the model and effort of an existing chat.
const MISSION = "model-feel";
type Frame = { t: number; footer: string; parts: { text: string; button: boolean; x: number; w: number }[]; menu: string };

const CATALOG: Record<string, { value: string; label: string; efforts?: string[] }[]> = {
  codex: [{ value: "gpt-6-astra", label: "GPT-6 Astra", efforts: ["low", "medium", "high"] }, { value: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["low", "medium", "high"] }],
  claudecode: [{ value: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "medium", "high"] }, { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"] }],
  opencode: [{ value: "personal-argon", label: "Argon", efforts: ["low", "medium", "high"] }, { value: "xai/grok-4.6", label: "xAI — Grok 4.6" }],
};

async function setup(page: Page, backend: string, saveDelay: number, fail = false) {
  const mission: Record<string, unknown> = { id: MISSION, project: "test", title: "Model feel", status: "awaiting_user", history: [], backend, model_override: CATALOG[backend][0].value, model_effort: "medium", created_at: "", updated_at: "" };
  const saves: unknown[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("orb.apiUrl", location.origin);
    localStorage.setItem("orb.jwt", "test");
    (window as any).frames_ = [];
    const sample = () => {
      const start = (window as any).recordStart;
      const under = Array.from(document.querySelectorAll(".dock .under")).at(-1) as HTMLElement | undefined;
      if (start && under) {
        const parts = Array.from(under.querySelectorAll(".under-model, .under-harness, .under-loc")).map(el => {
          const r = el.getBoundingClientRect();
          return { text: (el.textContent ?? "").trim(), button: el.tagName === "BUTTON" && !(el as HTMLButtonElement).disabled, x: Math.round(r.x), w: Math.round(r.width) };
        });
        const menu = Array.from(document.querySelectorAll("[role=menu], [role=listbox], [role=dialog]")).map(el => (el.getAttribute("aria-label") ?? el.className).slice(0, 30)).join("|");
        (window as any).frames_.push({ t: Math.round(performance.now() - start), footer: (under.textContent ?? "").trim(), parts, menu });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith("/settings") && req.method() === "PATCH") {
      const body = req.postDataJSON(); saves.push(body);
      await new Promise(r => setTimeout(r, saveDelay));
      if (fail) return route.fulfill({ status: 500, json: { error: "boom" } });
      Object.assign(mission, body);
      return route.fulfill({ json: mission });
    }
    if (path.endsWith("/events")) return route.fulfill({ json: [], headers: { "X-Orb-Events-Protocol": "1", "X-Has-More": "false", "X-Max-Sequence": "0" } });
    if (path === "/api/control/stream") return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path.endsWith("/queue")) return route.fulfill({ json: [] });
    if (path.startsWith("/api/control/missions/")) return route.fulfill({ json: mission });
    const json = path === "/api/projects" ? { projects: [{ slug: "test", title: "Test" }] }
      : path === "/api/control/missions" ? [mission]
      : path === "/api/backends" ? [{ id: backend, name: backend === "codex" ? "Codex" : backend === "claudecode" ? "Claude Code" : "OpenCode" }]
      : path === "/api/providers/backend-models" ? { backends: { [backend]: CATALOG[backend] } }
      : path === "/api/model-routing/chains" ? (backend === "opencode" ? CATALOG.opencode.map(m => ({ id: m.value, name: m.label })) : [])
      : path === "/api/remote-nodes" ? { enabled: true, nodes: [] }
      : path.endsWith("/files") ? { entries: [] } : path.endsWith("/crons") ? { jobs: [] } : { job: null, runs: [] };
    await route.fulfill({ json });
  });
  await page.goto("/#");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: /Model feel/ }).click();
  await expect(page.locator(".dock .under").last()).toBeVisible();
  await page.waitForTimeout(800);
  return { mission, saves };
}

async function frames(page: Page) { return (await page.evaluate(() => (window as any).frames_)) as Frame[]; }

function log(name: string, fs: Frame[]) {
  const lines: string[] = []; let prev = "";
  for (const f of fs) {
    const key = JSON.stringify([f.parts, f.menu]);
    if (key !== prev) lines.push(`${String(f.t).padStart(5)}ms menu=${f.menu || "-"} ${f.parts.map(p => `${p.button ? "[" : "("}${p.text}${p.button ? "]" : ")"}@${p.x}+${p.w}`).join(" ")}`);
    prev = key;
  }
  console.log(`\n=== ${name}\n${lines.join("\n")}`);
}

const short = (label: string) => label.replace(/^.*—\s*/, "").replace(/^Claude\s+/, "");

for (const backend of Object.keys(CATALOG)) {
  test(`changing model and effort (${backend})`, async ({ page }) => {
    const { saves } = await setup(page, backend, 800);
    await page.evaluate(() => { (window as any).recordStart = performance.now(); });
    const next = CATALOG[backend][1];
    const modelButton = page.locator(".dock .under button[title='Model for the next turn']");
    await modelButton.click();
    await page.getByRole("option", { name: short(next.label) }).first().click();
    const picked = await page.evaluate(() => performance.now() - (window as any).recordStart);
    await page.waitForTimeout(1200);
    const effortButton = page.locator(".dock .under button[aria-label^='Reasoning effort']");
    if (await effortButton.count()) {
      await effortButton.click();
      await page.getByRole("option", { name: /^High$/i }).first().click();
      await page.waitForTimeout(1200);
    }
    const fs = await frames(page);
    log(backend, fs);
    console.log("saves", JSON.stringify(saves));
    expect(saves.length).toBeGreaterThan(0);
    // The new model shows within a frame or two of the click, not after the save.
    const shown = fs.find(f => f.footer.includes(short(next.label)));
    expect(shown && shown.t - picked).toBeLessThan(100);
    // Once shown it never flips back to the old model.
    expect(fs.filter(f => f.t > shown!.t).every(f => f.footer.includes(short(next.label)))).toBe(true);
    // Controls stay buttons the whole time: no swap to plain text and back.
    for (const f of fs) for (const part of f.parts) if (!part.text.startsWith("Cyber")) expect(part.button, `${part.text} at ${f.t}ms`).toBe(true);
  });
}

test("a refused model change rolls back", async ({ page }) => {
  await setup(page, "codex", 300, true);
  await page.locator(".dock .under button[title='Model for the next turn']").click();
  await page.getByRole("option", { name: "GPT-6.1 Sol" }).first().click();
  await expect(page.locator(".dock .under")).toContainText("GPT-6.1 Sol");
  await expect(page.locator(".dock .under")).toContainText("GPT-6 Astra");
  await expect(page.locator(".dock .under")).not.toContainText("GPT-6.1 Sol");
});
