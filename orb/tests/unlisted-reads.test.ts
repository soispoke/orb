import { beforeEach, expect, test, vi } from "vitest";
import { forgetUnlistedReads, unlistedCoreState } from "../src/localOrigins";
import type { Mission } from "../src/api";

const mission = (id: string, status: string) => ({ id, status, title: id }) as unknown as Mission;

beforeEach(() => { forgetUnlistedReads(); vi.useRealTimers(); });

test("a conversation outside the list is not read again at every refresh", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async (id: string) => {
    if (id === "gone") throw new Error("404");
    return mission(id, id === "live" ? "active" : "completed");
  });
  const local = [mission("done", "completed"), mission("live", "completed"), mission("gone", "completed")];

  expect((await unlistedCoreState(local, [], read)).map(m => m.id)).toEqual(["done", "live"]);
  expect(read).toHaveBeenCalledTimes(3);

  vi.advanceTimersByTime(5_000);
  // The known state is still reported, without a request.
  expect((await unlistedCoreState(local, [], read)).map(m => m.id)).toEqual(["done", "live"]);
  expect(read).toHaveBeenCalledTimes(3);

  vi.advanceTimersByTime(30_000);
  await unlistedCoreState(local, [], read);
  expect(read.mock.calls.slice(3).map(call => call[0])).toEqual(["live"]);

  vi.advanceTimersByTime(10 * 60_000);
  await unlistedCoreState(local, [], read);
  expect(read.mock.calls.slice(4).map(call => call[0]).sort()).toEqual(["done", "gone", "live"]);
});

test("an old connection cannot populate the new account's cache", async () => {
  const {setConnection,clearConnection}=await import('../src/api');
  setConnection('http://first.test','first');
  let resolve!:(m:Mission)=>void;
  const stale=unlistedCoreState([mission('same','interrupted')],[],()=>new Promise(r=>resolve=r));
  setConnection('http://second.test','second');
  resolve(mission('same','acknowledged'));
  expect(await stale).toEqual([]);
  const read=vi.fn(async()=>mission('same','paused'));
  expect(await unlistedCoreState([mission('same','interrupted')],[],read)).toEqual([mission('same','paused')]);
  expect(read).toHaveBeenCalledOnce();
  clearConnection();
});

test("bounded lookups eventually cover more than twenty missing chats",async()=>{
 const rows=Array.from({length:25},(_,i)=>mission(String(i),'interrupted'));
 const read=vi.fn(async(id:string)=>mission(id,'paused'));
 await unlistedCoreState(rows,[],read);
 expect(read).toHaveBeenCalledTimes(20);
 expect(await unlistedCoreState(rows,[],read)).toHaveLength(25);
 expect(read).toHaveBeenCalledTimes(25);
});

test("invalid lookup identities do not replace the saved local chat",async()=>{
 expect(await unlistedCoreState([mission('one','interrupted')],[],async()=>mission('different','acknowledged'))).toEqual([]);
});

test("a lookup started before restore cannot repopulate the archive cache", async () => {
 let resolve!:(m:Mission)=>void;
 const rows=[mission('restored','interrupted')];
 const stale=unlistedCoreState(rows,[],()=>new Promise(r=>resolve=r));
 forgetUnlistedReads('restored');
 resolve(mission('restored','acknowledged'));
 expect(await stale).toEqual([]);
 const read=vi.fn(async()=>mission('restored','paused'));
 expect(await unlistedCoreState(rows,[],read)).toEqual([mission('restored','paused')]);
 expect(read).toHaveBeenCalledOnce();
});
