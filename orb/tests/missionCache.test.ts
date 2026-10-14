import { beforeEach, describe, expect, it } from "vitest";
import { peekReadyTranscript, putTranscript, putTranscriptItems } from "../src/missionCache";
import { cacheReset, prefetchProjectLimit } from "../src/pageCache";
import type { StreamItem } from "../src/transcriptModel";

const user = (text: string): StreamItem => ({ kind: "user", key: "u", text });

beforeEach(() => cacheReset());

describe("project warmup budget", () => {
  it("stays within 0..25", () => {
    const n = prefetchProjectLimit();
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(25);
  });
});

describe("transcript first-paint cache", () => {
  it("does not treat live SSE patches as ready", () => {
    putTranscriptItems("m1", [user("hi")]);
    expect(peekReadyTranscript("m1")).toBeUndefined();
  });
  it("treats an event-log snapshot as ready", () => {
    putTranscript("m1", { items: [user("hi")], stream: [], fromLog: true });
    expect(peekReadyTranscript("m1")?.items).toEqual([user("hi")]);
  });
  it("keeps the log snapshot when live items arrive", () => {
    putTranscript("m1", { items: [user("hi")], stream: [], fromLog: true });
    putTranscriptItems("m1", [user("hi"), { kind: "text", key: "t", text: "mashed", live: false }]);
    expect(peekReadyTranscript("m1")?.items).toEqual([user("hi")]);
  });
});

import { vi, afterEach } from "vitest";
import { loadTranscript } from "../src/missionCache";
afterEach(()=>vi.unstubAllGlobals());
it("reload joins durable pending IDs with delivered history and preserves order",async()=>{
  vi.stubGlobal("fetch",vi.fn(async (url:string)=>new Response(JSON.stringify(url.includes('/queue') ? [
    {id:"one",content:"same",mission_id:"m"},{id:"two",content:"same",mission_id:"m"},{id:"other",content:"private",mission_id:"other"},
  ] : [{id:1,event_id:"one",event_type:"user_message",content:"same",sequence:1,metadata:{queued:false},timestamp:""}]),{headers:{"X-Orb-Events-Protocol":"1","X-Has-More":"false","X-Next-Cursor":"1","X-Page-Max-Sequence":"1"}})));
  const snap=await loadTranscript("m");
  expect(snap.items).toMatchObject([{messageId:"one",queued:false},{messageId:"two",queued:true}]);
  expect(snap.queueError).toBeUndefined();
});
it("queue read failure preserves readable history and reports the missing queue evidence",async()=>{
  vi.stubGlobal("fetch",vi.fn(async (url:string)=>url.includes('/queue') ? new Response("Unavailable",{status:503}) : new Response(JSON.stringify([{id:1,event_id:"one",event_type:"user_message",content:"Known history",sequence:1,timestamp:""}]),{headers:{"X-Orb-Events-Protocol":"1","X-Has-More":"false","X-Next-Cursor":"1","X-Page-Max-Sequence":"1"}})));
  const snap=await loadTranscript("m");
  expect(snap.items).toMatchObject([{text:"Known history",queued:false}]);
  expect(snap.queueError).toContain("Queued messages could not refresh");
});
it("durable inflight evidence confirms the ID while the transcript logger is behind",async()=>{
  vi.stubGlobal("fetch",vi.fn(async (url:string)=>new Response(JSON.stringify(url.includes('/queue') ? [
    {id:"dispatched",content:"same",mission_id:"m",inflight:true},{id:"waiting",content:"same",mission_id:"m",inflight:false},
  ] : []),{headers:{"X-Orb-Events-Protocol":"1","X-Has-More":"false"}})));
  const snap=await loadTranscript("m");
  expect(snap.items).toMatchObject([{messageId:"dispatched",queued:false,receipt:true},{messageId:"waiting",queued:true}]);
});

import { forgetPrefetchPauses, prefetchTranscript } from "../src/missionCache";
it("a transcript the cache cannot hold is prefetched once, not at every refresh", async () => {
  cacheReset(); forgetPrefetchPauses();
  const big = "x".repeat(20 * 1024 * 1024);
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/queue") ? [] :
    [{ id: 1, event_id: "one", event_type: "assistant_message", content: big, sequence: 1, metadata: {}, timestamp: "" }]),
    { headers: { "X-Orb-Events-Protocol": "1", "X-Has-More": "false", "X-Next-Cursor": "1", "X-Page-Max-Sequence": "1", "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  prefetchTranscript("huge");
  await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  const after = fetchMock.mock.calls.length;
  expect(peekReadyTranscript("huge")).toBeUndefined();
  for (let i = 0; i < 5; i++) prefetchTranscript("huge");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(fetchMock.mock.calls.length).toBe(after);
});


it("places old inflight receipts in older history instead of after the latest response", async () => {
 const row = (sequence:number,id:string,type:string,content:string) => ({id:sequence,event_id:id,event_type:type,content,sequence,metadata:{queued:false},timestamp:''});
 const fetchMock = vi.fn(async (url:string) => {
  const queue=url.includes('/queue'), older=url.includes('view=transcript');
  const data=queue ? [{id:'old',content:'A+B asap',mission_id:'receipt-history',inflight:true}] : older ?
   [row(1,'old','user_message','A+B asap'),row(2,'old-reply','assistant_message','Already handled')] :
   [row(100,'recent','user_message','Optimize the build'),row(101,'reply','assistant_message','Optimizing now')];
  return new Response(JSON.stringify(data),{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':older?'false':'true','X-Next-Cursor':older?'1':'100','X-Page-Max-Sequence':older?'2':'101'}});
 });
 vi.stubGlobal('fetch',fetchMock);
 const snap=await loadTranscript('receipt-history');
 expect(snap.items.filter(item=>item.kind==='user').map(item=>item.text)).toEqual(['A+B asap','Optimize the build']);
 expect(snap.items.at(-1)).toMatchObject({kind:'text',text:'Optimizing now'});
 expect(snap.items.filter(item=>item.kind==='user'&&item.messageId==='old')).toHaveLength(1);
 expect(fetchMock.mock.calls.some(([url])=>url.includes('view=transcript'))).toBe(true);
});
