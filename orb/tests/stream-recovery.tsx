import {render} from 'solid-js/web';
import {createSignal, onCleanup} from 'solid-js';
import {Transcript, buildTranscript, applyStreamEvent} from '../src/Transcript';
import {streamMission, type StoredEvent} from '../src/stream';
import '../src/styles.css';
const encoder = new TextEncoder();
let channel: ReadableStreamDefaultController<Uint8Array>;
let snapshot: StoredEvent[] = [];
let reads = 0;
const original = window.fetch;
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('/api/control/stream?mission=fixture')) {
    return new Response(new ReadableStream({start(controller) {
      channel = controller;
      init?.signal?.addEventListener('abort', () => controller.close(), {once:true});
    }}), {headers:{'content-type':'text/event-stream'}});
  }
  if (url.includes('/api/control/missions/fixture/events?types=')) {
    reads++;
    return new Response(JSON.stringify(snapshot),{headers:{'content-type':'application/json'}});
  }
  return original(input, init);
};
function Gallery() {
  const [items, setItems] = createSignal(buildTranscript([{type:'user_message',data:{id:'q',content:'Status?'}}]));
  const stop = streamMission('fixture', event => setItems(current => applyStreamEvent(current,event)), () => {});
  onCleanup(stop);
  Object.assign(window,{recoveryHarness:{
    replay(events: import("../src/stream").StreamEvent[]) {setItems(buildTranscript(events));},
    send(type:string,data:Record<string,unknown>) {channel.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));},
    snapshot(text:string,sequence:number) {snapshot=[{id:1,event_id:'text_delta_latest',sequence,event_type:'text_delta',timestamp:new Date().toISOString(),content:text}];},
    jobStatus() {snapshot.push({id:2,sequence:snapshot[0].sequence+1,event_type:'assistant_message',timestamp:'',content:'Job is running',metadata:{kind:'remote_job_status'}});},
    reads: () => reads,
  }});
  return <main class="scroll" style={{height:'100vh'}}><div class="col"><Transcript items={items()}/></div></main>;
}
render(() => <Gallery/>,document.getElementById('root')!);
