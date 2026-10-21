import { expect, test } from "vitest";
import { applyStreamEvent, buildTranscript } from "../src/transcriptModel";

test("an event that changes nothing keeps the transcript's identity", () => {
  const items = buildTranscript([{ type: "user_message", data: { id: "u1", content: "hi" } }]);
  const same = applyStreamEvent(items, { type: "mission_activity", data: { label: "Tool running…" } });
  expect(same).toBe(items);
  const changed = applyStreamEvent(same, { type: "text_delta", data: { content: "hello", mode: "delta" } });
  expect(changed).not.toBe(items);
  expect(changed.length).toBe(2);
});

test("appending text ops on a long reply stay cheap", () => {
  let items = buildTranscript([{ type: "user_message", data: { id: "u1", content: "hi" } }]);
  const started = performance.now();
  for (let i = 0; i < 4000; i++) {
    items = applyStreamEvent(items, { type: "text_op", data: { bubble_id: "b", ops: [{ type: "insert", pos: 999999, text: "word ".repeat(10) }] } });
  }
  expect(performance.now() - started).toBeLessThan(500);
  const bubble = items.at(-1);
  expect(bubble?.kind === "text" && bubble.text.length).toBe(4000 * 50);
  // Positions still count code points for an insert in the middle.
  items = applyStreamEvent(buildTranscript([]), { type: "text_op", data: { bubble_id: "c", ops: [{ type: "insert", pos: 0, text: "héllo" }, { type: "insert", pos: 2, text: "X" }] } });
  const middle = items.at(-1);
  expect(middle?.kind === "text" && middle.text).toBe("héXllo");
});

test('snapshot revisions and their canonical receipt retain the display segment',()=>{
 const user={type:'user_message',data:{id:'question',content:'Continue'}};
 const first={type:'text_delta',eventId:'text_delta_latest',sequence:10,data:{content:'Checking'}};
 const next={...first,sequence:20,data:{content:'Checking complete'}};
 const final={type:'assistant_message',eventId:'final',data:{content:'Checking complete'}};
 const key=buildTranscript([user,first]).at(-1)!.key;
 expect(buildTranscript([user,next]).at(-1)!.key).toBe(key);
 expect(buildTranscript([user,final]).at(-1)!.key).toBe(key);
 const twice=buildTranscript([user,final,{...final,eventId:'another-final'}]);
 expect(new Set(twice.map(i=>i.key)).size).toBe(twice.length);
});

test('steering splits a native item without reusing the old display key',()=>{
 const text={type:'text_op',data:{bubble_id:'codex:mission:item',ops:[{type:'snapshot',revision:1,text:'Before.'}]}};
 const items=buildTranscript([{type:'user_message',data:{id:'first',content:'Continue'}},text,{type:'user_message',data:{id:'steer',content:'Status'}},{...text,data:{...text.data,ops:[{type:'snapshot',revision:2,text:'Before. After.'}]}}]);
 const replies=items.filter(i=>i.kind==='text');
 expect(replies).toHaveLength(2);
 expect(replies[0].key).not.toBe(replies[1].key);
});
