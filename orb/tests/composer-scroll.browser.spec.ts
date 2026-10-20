import {eventPage} from "./eventPageFixture";
test("a downward gesture at the bottom restores following even without a scroll event", async ({page}) => {
  await setup(page,true);
  await settledTranscript(page);
  const scroll=page.locator('.scroll');
  await expect.poll(()=>scroll.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
  // Trackpad direction changes can happen at the boundary without changing
  // scrollTop, so the browser has no scroll event to announce.
  await scroll.dispatchEvent('wheel',{deltaY:-1});
  await scroll.dispatchEvent('wheel',{deltaY:20});
  await page.evaluate(()=>(window as any).emitScrollTestEvent('text_delta',{bubble_id:'after-tail-gesture',content:'New streamed output. '.repeat(300)}));
  await expect(page.locator('.st-text').last()).toContainText('New streamed output.');
  await expect.poll(()=>scroll.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
});

import { test, expect, type Page } from "@playwright/test";

const MISSION = "9f2a91c4-8b7d-4e21-9a0c-5d6e7f801235";
const answer = Array.from({length:10},(_,i)=>`${i+1}. **Question ${i+1}:** ${"Should we keep the current proof or change its scope before delivery? ".repeat(3)}`).join("\n");

async function setup(page: Page, active = false, turns = 6, duringLoad?: () => Promise<void>, cloud = false, postDelay = 250, varied = false) {
  const mission = { id: MISSION, project: "test", title: "Pareto audit", status: active ? "active" : "awaiting_user", history: [], backend: cloud ? "cloud_chatgpt" : "codex", created_at: "", updated_at: "" };
  const events = Array.from({length:turns},(_,i)=>[
    { id:`u${i}`, event_id:`u${i}`, sequence:i*2+1, event_type:"user_message", content:`Request ${i}`, timestamp:"" },
    { id:`a${i}`, event_id:`a${i}`, sequence:i*2+2, event_type:"assistant_message", content:varied ? answer.repeat(i%3+1) : answer, timestamp:"" },
  ]).flat();
  await page.addInitScript(() => {
    localStorage.setItem("orb.apiUrl", location.origin);
    localStorage.setItem("orb.jwt", "test");
    localStorage.setItem("orb-theme", "dark");
    // Sample every paint, not just the eventual settled scroll position.
    (window as any).openingFrames = [];
    const seen = new WeakMap<Element, number>();
    const sample = () => {
      const scroll = document.querySelector('.scroll');
      const text = scroll?.querySelector('.st-text');
      if (scroll && text && getComputedStyle(text).visibility !== 'hidden') {
        const count = seen.get(scroll) ?? 0;
        if (count < 8) {
          (window as any).openingFrames.push({frame: count, gap: scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight, bottom: scroll.querySelectorAll(".st-text").item(scroll.querySelectorAll(".st-text").length-1)?.getBoundingClientRect().bottom});
          seen.set(scroll, count+1);
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
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
    if (path === '/api/cloud/accounts') return route.fulfill({json:[]});
    if (path.endsWith('/cloud')) {
      if (duringLoad) await new Promise(resolve => setTimeout(resolve, 700));
      return route.fulfill({json:{mission_id:MISSION, revision:1, selection:{provider:'chatgpt', account:'fixture'}, turns:Array.from({length:turns},(_,i)=>({key:`turn${i}`,prompt:`Request ${i}`,phase:'completed',result:answer,artifacts:[],branches:[]}))}});
    }
    if (path.endsWith("/events")) {
      if (duringLoad) await new Promise(resolve => setTimeout(resolve, 700));
      return route.fulfill(eventPage(route, events));
    }
    if (path === "/api/control/stream") return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path.endsWith("/message")) {
      const body = route.request().postDataJSON();
      await new Promise(resolve => setTimeout(resolve, postDelay));
      queued.push({id:body.client_message_id,content:body.content,source:"remote-queue"});
      return route.fulfill({json:{id:body.client_message_id, queued:active}});
    }
    if (path.endsWith("/send-now")) {
      const id=path.split("/").at(-2); const index=queued.findIndex(row=>row.id===id);
      if(index>=0)queued.splice(index,1);
      return route.fulfill({json:{ok:true,delivered:true}});
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
  if (duringLoad) await duringLoad();
  await expect(page.locator(".st-text").last()).toContainText("Question 10");
  // Start with an established conversation, after fonts and virtual row
  // measurements settle; opening history has its own tail-positioning phase.
  await settledTranscript(page);
}

async function settledTranscript(page: Page) {
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
  // Let virtualization finish the manual scroll before measuring the typing
  // interaction. A single RAF can run before the pending row measurement.
  await settledTranscript(page);
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


for (const turns of [6, 60]) test(`steering in a ${turns}-turn session reveals the message and stays pinned`, async ({page}) => {
  await setup(page, true, turns);
  const scroll = page.locator(".scroll");
  const reply = page.locator(".st-text").last();
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(80);
  await page.waitForTimeout(150);
  await page.locator(".composer textarea").click();
  await page.locator(".composer textarea").fill("Please also check the final estimate");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator(".composer textarea").press("Enter");
  await expect(page.locator(".composer textarea")).toHaveValue("");
  await expect(page.locator(".user").last()).toHaveText("Please also check the final estimate");
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
  await expect(page.getByText("Sent to the running session. The agent reads it after its current step; work continues.",{exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Queued messages"})).toHaveCount(0);
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
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


test("opening delayed long history while typing still opens at the latest reply", async ({page}) => {
  await setup(page, true, 60, async () => {
    await page.locator(".composer textarea").click();
    await page.locator(".composer textarea").fill("Keep this draft while history loads");
  });
  const scroll=page.locator(".scroll");
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
  await expect(page.locator(".composer textarea")).toHaveValue("Keep this draft while history loads");
});

test("a long conversation remains pinned when the window gets narrower", async ({page}) => {
  await setup(page, true, 60);
  const scroll=page.locator(".scroll");
  await page.locator(".composer textarea").click();
  await page.setViewportSize({width:850,height:700});
  await expect.poll(() => scroll.evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
});

test("expanding work at the tail keeps the clicked heading in place", async ({page}) => {
  await setup(page, true, 60);
  await page.evaluate(() => {
    const emit=(window as any).emitScrollTestEvent;
    emit("tool_call", {tool_call_id:"scroll-tool",name:"bash",args:{command:"synthetic diagnostic"}});
    emit("tool_result", {tool_call_id:"scroll-tool",result:Array.from({length:100},(_,i)=>`Output line ${i}`).join("\n")});
  });
  const work=page.locator(".st-work-head").last();
  await expect(work).toBeVisible();
  await page.waitForTimeout(250);
  const before=(await work.boundingBox())!.y;
  await work.click();
  await page.waitForTimeout(350);
  expect(Math.abs((await work.boundingBox())!.y-before)).toBeLessThan(2);
  const tool=page.locator(".st-tool-head").last();
  // Bring the newly revealed button into view before measuring. Playwright's
  // click would otherwise scroll an offscreen button as part of the action.
  await page.locator(".scroll").dispatchEvent("wheel", {deltaY:500});
  await tool.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const toolBefore=(await tool.boundingBox())!.y;
  await tool.click();
  await page.waitForTimeout(350);
  expect(Math.abs((await tool.boundingBox())!.y-toolBefore)).toBeLessThan(2);
});

test("reading an earlier turn survives incoming output and history refresh", async ({page}) => {
  await setup(page,true,60);
  const scroll=page.locator(".scroll");
  await scroll.dispatchEvent("wheel",{deltaY:-3000});
  await scroll.evaluate(el=>{el.scrollTop-=3000;el.dispatchEvent(new Event("scroll"));});
  await page.waitForTimeout(400);
  const anchor=await page.evaluate(()=>{
    const box=document.querySelector(".scroll")!.getBoundingClientRect();
    const row=Array.from(document.querySelectorAll<HTMLElement>("[data-turn-key]")).find(row=>{const r=row.getBoundingClientRect();return r.top<=box.top+100&&r.bottom>box.top+100;})!;
    return {key:row.dataset.turnKey!,y:row.getBoundingClientRect().y};
  });
  await page.evaluate(()=> (window as any).emitScrollTestEvent("text_delta",{bubble_id:"long-live",content:"Streaming content. ".repeat(300)}));
  await page.waitForTimeout(500);
  const y=await page.locator(`[data-turn-key="${anchor.key}"]`).evaluate(el=>el.getBoundingClientRect().y);
  expect(Math.abs(y-anchor.y)).toBeLessThan(2);
  await page.evaluate(()=>window.dispatchEvent(new Event("orb:refresh")));
  await page.waitForTimeout(500);
  expect(Math.abs(await page.locator(`[data-turn-key="${anchor.key}"]`).evaluate(el=>el.getBoundingClientRect().y)-anchor.y)).toBeLessThan(2);
});


test("reopening a long conversation opens at its latest reply", async ({page}) => {
  await setup(page, true, 60);
  await page.getByRole("button",{name:/New Agent/}).click();
  await page.getByRole("button",{name:/Pareto audit/}).click();
  await expect(page.locator(".st-text").last()).toContainText("Question 10");
  await expect.poll(()=>page.locator(".scroll").evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
});

test("searching an older turn stays there while new output arrives", async ({page}) => {
  await setup(page,true,60);
  await page.locator(".composer textarea").click();
  await page.keyboard.press("Meta+f");
  const find=page.getByRole("textbox",{name:"Find in conversation"});
  await find.fill("Request 12");
  await expect(page.locator(".find-count")).toHaveText("1 / 1");
  const row=page.locator('[data-turn-key="user:u12"]');
  await expect(row).toBeVisible();
  await page.waitForTimeout(300);
  const before=(await row.boundingBox())!.y;
  await page.evaluate(()=> (window as any).emitScrollTestEvent("text_delta",{bubble_id:"during-search",content:"New output while searching. ".repeat(100)}));
  await page.waitForTimeout(300);
  expect(Math.abs((await row.boundingBox())!.y-before)).toBeLessThan(2);
  await find.press("Escape");
  await expect(find).not.toBeVisible();
});

test("dragging the overlay scrollbar upward suspends following", async ({page}) => {
  await setup(page,true,60);
  const scroll=page.locator(".scroll");
  const box=(await scroll.boundingBox())!;
  await page.mouse.move(box.x+box.width-8,box.y+box.height-12);
  const thumb=page.locator(".transcript-scroll-thumb");
  await expect(thumb).toBeVisible();
  const handle=(await thumb.boundingBox())!;
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);
  await page.mouse.down();
  await page.mouse.move(handle.x+handle.width/2,handle.y-150,{steps:8});
  await page.mouse.up();
  await page.waitForTimeout(300);
  const before=await scroll.evaluate(el=>el.scrollTop);
  await expect.poll(()=>scroll.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight)).toBeGreaterThan(1000);
  await page.evaluate(()=> (window as any).emitScrollTestEvent("text_delta",{bubble_id:"during-drag",content:"New output while reading. ".repeat(100)}));
  await page.waitForTimeout(300);
  expect(Math.abs(await scroll.evaluate(el=>el.scrollTop)-before)).toBeLessThan(2);
});

for (const turns of [6, 60, 200]) test(`opening ${turns} turns paints the latest messages from the first visible frame`, async ({page}) => {
  await setup(page, false, turns, async () => {
    await page.locator('.composer textarea').fill('Draft during loading');
  }, false, 250, turns > 100);
  await expect.poll(() => page.evaluate(() => (window as any).openingFrames.length)).toBeGreaterThanOrEqual(8);
  const frames = await page.evaluate(() => (window as any).openingFrames);
  expect(frames.length).toBeGreaterThanOrEqual(8);
  expect(frames.every((f: {gap:number}) => Math.abs(f.gap) <= 2), JSON.stringify(frames)).toBe(true);
  expect(Math.max(...frames.map((f:{bottom:number})=>f.bottom))-Math.min(...frames.map((f:{bottom:number})=>f.bottom))).toBeLessThanOrEqual(1);
  await page.getByRole('button', {name:/New Agent/}).click();
  await page.getByRole('button', {name:/Pareto audit/}).click();
  await settledTranscript(page);
  await expect.poll(() => page.evaluate(() => (window as any).openingFrames.length)).toBeGreaterThanOrEqual(16);
  const reopened = await page.evaluate(() => (window as any).openingFrames.slice(8));
  expect(reopened.length).toBeGreaterThanOrEqual(8);
  expect(reopened.every((f: {gap:number}) => Math.abs(f.gap) <= 2), JSON.stringify(reopened)).toBe(true);
});

for (const turns of [6,60]) test(`cloud chat with ${turns} turns opens at the latest content without a top flash`,async({page})=>{
  await setup(page,false,turns,async()=>{},true);
  await expect.poll(()=>page.evaluate(()=>(window as any).openingFrames.length)).toBeGreaterThanOrEqual(8);
  const frames=await page.evaluate(()=>(window as any).openingFrames);
  expect(frames.every((f:{gap:number})=>Math.abs(f.gap)<=2),JSON.stringify(frames)).toBe(true);
});

for(const active of [false,true]) test(`typing and Enter stay responsive ${active?'during a run':'in an idle chat'} with a slow send`,async({page},testInfo)=>{
 await setup(page,active,60,undefined,false,1500);
 const input=page.locator('.composer textarea');
 await input.click();
 await page.evaluate(()=>{
  const timings:number[]=[];(window as any).typingTimings=timings;
  let start=0;
  document.addEventListener('input',e=>{if(e.target instanceof HTMLTextAreaElement)start=performance.now();},true);
  document.addEventListener('input',e=>{if(e.target instanceof HTMLTextAreaElement)timings.push(performance.now()-start);});
 });
 await input.pressSequentially('Please check the next step carefully. '.repeat(5));
 const timings:number[]=await page.evaluate(()=>(window as any).typingTimings);
 const sorted=[...timings].sort((a,b)=>a-b),p95=sorted[Math.floor(sorted.length*.95)];
 expect(p95).toBeLessThan(50);
 await input.press('Enter');
 await expect(input).toHaveValue('');
 await expect(input).toBeEditable();
 await expect(page.getByText('Please check the next step carefully. '.repeat(5).trim(),{exact:true})).toBeVisible({timeout:500});
 await input.pressSequentially('Keep this next draft while the send finishes');
 await page.waitForTimeout(1600);
 await expect(input).toHaveValue('Keep this next draft while the send finishes');
 console.log('TYPING_TIMING',testInfo.project.name,active?'running':'idle',JSON.stringify({p95HandlerMs:p95,maxHandlerMs:Math.max(...timings)}));
 await testInfo.attach('typing-timing.json',{body:JSON.stringify({events:timings.length,p95HandlerMs:p95,maxHandlerMs:Math.max(...timings)}),contentType:'application/json'});
});

test('one Enter steers once after admission while a new draft stays editable', async ({page}) => {
  await setup(page, true, 60, undefined, false, 700);
  let steers = 0;
  await page.route('**/queue/*/send-now', async route => {
    steers++;
    await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({json: {ok: true, delivered: true}});
  });
  const input = page.locator('.composer textarea');
  await input.fill('Check the next layout issue');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(steers).toBe(0);
  await expect(page.locator('.user').last()).toHaveText('Check the next layout issue');
  await input.fill('Preserve this next draft');
  await expect.poll(() => steers).toBe(1);
  await expect(page.getByText(/Sent to the running session/)).toBeVisible();
  await expect(input).toHaveValue('Preserve this next draft');
  expect(steers).toBe(1);
});

test('a refused live steer stays queued without claiming delivery or losing the next draft', async ({page}) => {
  await setup(page, true);
  let steers=0;
  await page.route('**/queue/*/send-now', async route => {
    steers++;
    await route.fulfill({json:{ok:true,delivered:false}});
  });
  const input=page.locator('.composer textarea');
  await input.fill('Check another layout issue');await input.press('Enter');
  await expect(page.getByText('Queued for the next turn. Work continues.')).toBeVisible();
  await expect(page.getByText('Couldn’t send your message')).toHaveCount(0);
  await expect(page.getByText(/Waiting for the session to accept/)).toHaveCount(0);
  await input.fill('Keep this next draft');
  await expect(input).toHaveValue('Keep this next draft');
  expect(steers).toBe(1);
  await input.press('Enter');
  await expect.poll(()=>steers).toBe(2);
  await expect(page.getByRole('region',{name:'Queued messages'})).toContainText('Keep this next draft');
});

test('command bursts keep the latest text pinned on every visible frame', async ({page}) => {
 await setup(page,true,60);
 await page.locator('.composer textarea').click();
 const frames=await page.evaluate(async()=>{
  const scroll=document.querySelector('.scroll')!;
  const gaps:number[]=[];let sampling=true;
  // Sample the layout at paint time, after queued frame callbacks have run.
  const sample=()=>{if(!sampling)return;requestAnimationFrame(()=>{setTimeout(()=>{if(sampling)gaps.push(scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight);sample();},0);});};
  sample();
  const emit=(window as any).emitScrollTestEvent;
  for(let i=0;i<12;i++){
   emit('text_op',{bubble_id:`codex:frame-test:item-${i}`,ops:[{type:'snapshot',revision:1,text:`Checked command ${i}.\n\nDetails remain stable.`},{type:'finalize'}]});
   emit('tool_call',{tool_call_id:`frame-tool-${i}`,name:'bash',args:{command:`printf ${i}`}});
   await new Promise(resolve=>setTimeout(resolve,60));
   emit('tool_result',{tool_call_id:`frame-tool-${i}`,result:String(i)});
  }
  await new Promise(resolve=>setTimeout(resolve,100));sampling=false;
  return gaps;
 });
 expect(frames.length).toBeGreaterThan(10);
 expect(Math.max(...frames),JSON.stringify(frames)).toBeLessThanOrEqual(2);
});

for(const active of [false,true]) test(`draft resizing stays stable frame by frame in ${active?'active':'idle'} chats`,async({page})=>{
 await setup(page,active,60);
 const input=page.locator('.composer textarea');await input.click();
 await page.evaluate(()=>{
  const ta=document.querySelector('.composer textarea') as HTMLTextAreaElement;
  const last=Array.from(document.querySelectorAll('.st-text')).at(-1)!;
  const baseline={reply:last.getBoundingClientRect().y,bottom:ta.closest('.composer')!.getBoundingClientRect().bottom};
  (window as any).draftFrames=[];(window as any).sampleDraft=true;
  const sample=()=>requestAnimationFrame(()=>setTimeout(()=>{
   if(!(window as any).sampleDraft)return;
   const box=ta.closest('.composer')!.getBoundingClientRect();
   (window as any).draftFrames.push({length:ta.value.length,selection:ta.selectionStart,height:box.height,bottom:box.bottom-baseline.bottom,reply:last.getBoundingClientRect().y-baseline.reply,focus:document.activeElement===ta});sample();
  },0));sample();
 });
 await input.pressSequentially('Please keep the ongoing audit running and check the result carefully. '.repeat(10),{delay:2});
 for(let i=0;i<8;i++){await input.press('Shift+Enter');await input.pressSequentially(`Extra detail ${i}.`);}
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const frames=await page.evaluate(()=>{(window as any).sampleDraft=false;return (window as any).draftFrames;});
 expect(frames.length).toBeGreaterThan(20);
 const bad=frames.filter((f:any,i:number)=>Math.abs(f.bottom)>1||Math.abs(f.reply)>1||!f.focus||f.selection!==f.length||(i>0&&f.height<frames[i-1].height-1));
 expect(bad,JSON.stringify(bad)).toEqual([]);
});

for(const active of [false,true]) test(`clearing a tall draft keeps the chat still in ${active?'active':'idle'} chats`,async({page})=>{
 await setup(page,active,60);
 const input=page.locator('.composer textarea');await input.click();
 await input.fill('A long draft line.\n'.repeat(20));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))));
 const baseline=await page.locator('.st-text').last().evaluate(el=>el.getBoundingClientRect().y);
 await page.evaluate(()=>{
  (window as any).clearFrames=[];(window as any).sampleClear=true;
  const sample=()=>requestAnimationFrame(()=>setTimeout(()=>{
   if(!(window as any).sampleClear)return;
   (window as any).clearFrames.push(Array.from(document.querySelectorAll('.st-text')).at(-1)!.getBoundingClientRect().y);sample();
  },0));sample();
 });
 await input.press('ControlOrMeta+a');await input.press('Backspace');
 await input.pressSequentially('Short replacement',{delay:15});
 await page.waitForTimeout(100);
 const frames=await page.evaluate(()=>{(window as any).sampleClear=false;return (window as any).clearFrames;});
 expect(frames.every((y:number)=>Math.abs(y-baseline)<=1),JSON.stringify({baseline,frames})).toBe(true);
 await expect(input).toHaveValue('Short replacement');
});

for (const running of [true, false]) test(`a draft reflows with the composer width before the next keystroke (${running ? 'active' : 'idle'})`,async({page})=>{
 await setup(page,running,60);
 const input=page.locator('.composer textarea');await input.click();
 await input.fill('Please keep checking the active audit and preserve its results. '.repeat(6));
 await page.waitForTimeout(100);
 await page.setViewportSize({width:780,height:900});
 await expect.poll(()=>input.evaluate(el=>el.clientHeight>=218||el.scrollHeight-el.clientHeight<=1)).toBe(true);
 const narrow=await input.evaluate(el=>el.clientHeight);
 await input.evaluate(el=>el.setSelectionRange(0, 0));
 await page.setViewportSize({width:1300,height:900});
 await expect.poll(()=>input.evaluate(el=>el.clientHeight)).toBeLessThan(narrow);
 await expect(input).toBeFocused();
 expect(await input.evaluate(el=>[el.selectionStart,el.selectionEnd])).toEqual([0,0]);
 await input.pressSequentially('Prefix ');
 await expect(input).toHaveValue('Prefix '+'Please keep checking the active audit and preserve its results. '.repeat(6));
});

for(const delivered of [true,false]) test(`a long submitted draft stays above the dock after ${delivered?'live delivery':'queue fallback'}`,async({page})=>{
 await setup(page,true,60);
 await page.route('**/queue/*/send-now',async route=>route.fulfill({json:{ok:true,delivered}}));
 const draft='Please explain the measurement and preserve the ongoing worker. '.repeat(12);
 const input=page.locator('.composer textarea');await input.fill(draft);
 await page.waitForTimeout(100);await input.press('Enter');
 await expect(page.getByText(delivered?'Sent to the running session. The agent reads it after its current step; work continues.':'Queued for the next turn. Work continues.',{exact:true})).toBeVisible();
 if(delivered){
  const bubble=page.locator('.scroll .user').last();await expect(bubble).toHaveText(draft.trim());
  await expect.poll(async()=>{
   const bottom=await bubble.evaluate(el=>el.getBoundingClientRect().bottom);
   const dock=await page.locator('.dock').evaluate(el=>el.getBoundingClientRect().top);
   return bottom-dock;
  }).toBeLessThanOrEqual(-16);
 }else{
  const queue=page.getByRole('region',{name:'Queued messages'});await expect(queue).toContainText(draft.trim());
  const box=(await queue.boundingBox())!,composer=(await page.locator('.composer').boundingBox())!;
  expect(box.y+box.height).toBeLessThanOrEqual(composer.y);
 }
});

test('a delivered queue receipt clears the stale queued notice and reveals the message',async({page})=>{
 await setup(page,true,60);
 await page.route('**/queue/*/send-now',async route=>route.fulfill({json:{ok:true,delivered:false}}));
 const sent=page.waitForRequest(request=>new URL(request.url()).pathname.endsWith('/message'));
 const input=page.locator('.composer textarea');await input.fill('Explain the worker and keep it running');await input.press('Enter');
 const request=await sent;const id=request.postDataJSON().client_message_id;
 await expect(page.getByText('Queued for the next turn. Work continues.',{exact:true})).toBeVisible();
 await page.evaluate(({id})=>(window as any).emitScrollTestEvent('user_message',{id,content:'Explain the worker and keep it running',queued:false,source:'host-queue:api:default'}),{id});
 await expect(page.getByText('Queued for the next turn. Work continues.',{exact:true})).toHaveCount(0);
 await expect(page.locator('.scroll .user').last()).toHaveText('Explain the worker and keep it running');
 await expect.poll(async()=>{
  const bottom=await page.locator('.scroll .user').last().evaluate(el=>el.getBoundingClientRect().bottom);
  const dock=await page.locator('.dock').evaluate(el=>el.getBoundingClientRect().top);
  return bottom-dock;
 }).toBeLessThanOrEqual(-16);
});
