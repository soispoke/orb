import {eventPage} from "./eventPageFixture";
import { test, expect, type Page } from "@playwright/test";

const MISSION = "9f2a91c4-8b7d-4e21-9a0c-5d6e7f801235";
const answer = Array.from({length:10},(_,i)=>`${i+1}. **Question ${i+1}:** ${"Should we keep the current proof or change its scope before delivery? ".repeat(3)}`).join("\n");

async function setup(page: Page, active = false, turns = 6) {
  const mission = { id: MISSION, title: "Pareto audit", status: active ? "active" : "awaiting_user", history: [], backend: "codex", created_at: "", updated_at: "" };
  const events = Array.from({length:turns},(_,i)=>[
    { id:`u${i}`, event_id:`u${i}`, sequence:i*2+1, event_type:"user_message", content:`Request ${i}`, timestamp:"" },
    { id:`a${i}`, event_id:`a${i}`, sequence:i*2+2, event_type:"assistant_message", content:answer, timestamp:"" },
  ]).flat();
  await page.addInitScript(() => {
    localStorage.setItem("orb.apiUrl", location.origin);
    localStorage.setItem("orb.jwt", "test");
    localStorage.setItem("orb-theme", "dark");
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input).includes("/api/control/stream?mission=")) {
        return new Response(new ReadableStream({start(controller) {
          (window as any).emitScrollTestEvent = (type:string, data:unknown) => controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
          init?.signal?.addEventListener("abort", () => controller.close(), {once:true});
        }}), {headers:{"Content-Type":"text/event-stream"}});
      }
      return originalFetch(input,init);
    };
  });
  const queued: {id:string; content:string; source:string}[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/model-routing/chains") return route.fulfill({json:[]});
    if (path.endsWith("/events")) return route.fulfill(eventPage(route, events));
    if (path === "/api/control/stream") return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path.endsWith("/message")) {
      const body = route.request().postDataJSON();
      await new Promise(resolve => setTimeout(resolve, 250));
      queued.push({id:body.client_message_id,content:body.content,source:"remote-queue"});
      return route.fulfill({json:{id:body.client_message_id, queued:active}});
    }
    if (path.endsWith("/queue")) return route.fulfill({ json: queued });
    if (path.startsWith("/api/control/missions/")) return route.fulfill({ json: mission });
    const json = path === "/api/projects" ? { projects: [{ slug: "test", title: "Test" }] }
      : path === "/api/control/missions" ? [mission]
      : path === "/api/backends" ? [{ id: "codex", name: "Codex" }]
      : path === "/api/providers/backend-models" ? { backends: { codex: [{ value: "gpt-6-astra", label: "GPT-6 Astra" }] } }
      : path === "/api/remote-nodes" ? { enabled: true, nodes: [] }
      : path.endsWith("/files") ? { entries: [] }
      : path.endsWith("/crons") ? { jobs: [] } : { job: null, runs: [] };
    await route.fulfill({ json });
  });
  await page.goto(`/#`);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: /Pareto audit/ }).click();
  await expect(page.locator(".st-text").last()).toContainText("Question 10");
  // Start with an established conversation, after fonts and virtual row
  // measurements settle; opening history has its own tail-positioning phase.
  await page.evaluate(async () => {
    await document.fonts.ready;
    let previous = "", stable = 0;
    for (let frame=0; frame<180; frame++) {
      await new Promise(requestAnimationFrame);
      const el = document.querySelector(".scroll")!;
      const last = Array.from(document.querySelectorAll(".st-text")).at(-1)!;
      const state = `${el.scrollTop}:${el.scrollHeight}:${last.getBoundingClientRect().y}`;
      stable = state === previous ? stable+1 : 0;
      if (stable >= 8) return;
      previous = state;
    }
    throw new Error("Transcript did not settle before interaction");
  });
}

test("typing a long reply keeps the transcript and the caret line where they are", async ({ page }) => {
  await setup(page);
  const scroll = page.locator(".scroll");
  // Let initial tail layout settle, then use the same manual-scroll signal as
  // the browser. A bare scrollTop assignment can race the initial opening pin.
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(80);
  await scroll.dispatchEvent("wheel", {deltaY:-200});
  // Reading the questions a little above the bottom, as when answering them.
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 200; el.dispatchEvent(new Event("scroll")); });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const before = (await page.locator(".st-text").last().boundingBox())!.y;
  const input = page.locator(".composer textarea");
  await input.click();
  const hidden: string[] = [];
  const check = async (step: string) => {
    const [top, below] = await page.evaluate(() => {
      const t = document.querySelector(".composer textarea") as HTMLTextAreaElement;
      return [Array.from(document.querySelectorAll(".st-text")).at(-1)!.getBoundingClientRect().y, t.scrollHeight - t.scrollTop - t.clientHeight];
    });
    if (Math.abs(top - before) > 1 || below > 1) hidden.push(`${step}: transcript ${before} -> ${top}, ${below}px below caret`);
  };
  for (let i = 1; i <= 9; i++) {
    await input.pressSequentially(`${i}) answer ${i}`); await check(`${i}`);
    // A blank line between answers used to leave the new caret line out of view.
    await input.press("Shift+Enter"); await check(`${i}+`);
    await input.press("Shift+Enter"); await check(`${i}++`);
  }
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(hidden).toEqual([]);
});


for (const turns of [6, 60]) test(`queuing a follow-up in a ${turns}-turn session keeps the reply in place`, async ({page}) => {
  await setup(page, true, turns);
  const scroll = page.locator(".scroll");
  const reply = page.locator(".st-text").last();
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(80);
  await page.waitForTimeout(150);
  await page.locator(".composer textarea").click();
  await page.locator(".composer textarea").fill("Please also check the final estimate");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = (await reply.boundingBox())!.y;
  await page.locator(".composer textarea").press("Enter");
  await expect(page.locator(".composer textarea")).toHaveValue("");
  await page.waitForTimeout(700);
  expect(Math.abs((await reply.boundingBox())!.y-before)).toBeLessThan(2);
});


test("live replies still follow at the bottom and respect scrolling up", async ({page}) => {
  await setup(page, true);
  const scroll = page.locator(".scroll");
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(80);
  await page.locator(".composer textarea").click();
  await page.evaluate(() => (window as any).emitScrollTestEvent("text_delta", {bubble_id:"live-follow",content:"New streamed reply. ".repeat(80)}));
  await expect(page.locator(".st-text").last()).toContainText("New streamed reply.");
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
  await scroll.dispatchEvent("wheel", {deltaY:-200});
  await scroll.evaluate(el => {el.scrollTop -= 200; el.dispatchEvent(new Event("scroll"));});
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const before=(await page.locator(".st-text").last().boundingBox())!.y;
  await page.evaluate(() => (window as any).emitScrollTestEvent("text_delta", {bubble_id:"live-follow",mode:"delta",content:"More streamed output. ".repeat(80)}));
  await expect(page.locator(".st-text").last()).toContainText("More streamed output.");
  await page.waitForTimeout(150);
  expect(Math.abs((await page.locator(".st-text").last().boundingBox())!.y-before)).toBeLessThan(2);
  await scroll.hover();
  await page.mouse.wheel(0, 10000);
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
  await page.waitForTimeout(150);
  await page.evaluate(() => (window as any).emitScrollTestEvent("text_delta", {bubble_id:"live-follow",mode:"delta",content:"Following again. ".repeat(80)}));
  await expect(page.locator(".st-text").last()).toContainText("Following again.");
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
});

test("sending a new turn in an idle chat still reveals the sent message", async ({page}) => {
  await setup(page);
  const scroll=page.locator(".scroll");
  await scroll.dispatchEvent("wheel", {deltaY:-500});
  await scroll.evaluate(el=>{el.scrollTop=500;el.dispatchEvent(new Event("scroll"));});
  await page.locator(".composer textarea").fill("A new turn from earlier in the conversation");
  await page.locator(".composer textarea").press("Enter");
  await expect(page.locator(".user").last()).toContainText("A new turn from earlier in the conversation");
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
});
