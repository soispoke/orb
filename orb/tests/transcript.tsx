import { render } from "solid-js/web";
import { createSignal } from "solid-js";
const source = new URLSearchParams(location.search).has("baseline") ? "/src/_benchmarkBefore.tsx" : "/src/Transcript.tsx";
const { Transcript, buildTranscript, applyStreamEvent } = await import(/* @vite-ignore */ source);
import {recoverLocalTranscript} from '../src/localTranscriptRecovery';
import {projectLocalTranscript,createLocalTranscriptProjection} from '../src/localTranscript';
import type {LocalTranscriptBoundary} from '../src/localTranscript';
import type {StreamItem} from '../src/transcriptModel';
import {saveLocalTranscriptBoundary,loadLocalTranscriptBoundaries,localTranscriptBoundaries} from '../src/localTranscriptStorage';
import type { StreamEvent } from "../src/stream";
import {storedToStream, heldAfterHistory, createThinkingBoundaryTracker, type StoredEvent} from '../src/stream';
import "../src/styles.css";
const events: StreamEvent[] = [];
for (let i=0;i<300;i++) events.push(
 {type:"user_message",data:{content:`Question ${i}`,id:`u${i}`}},
 {type:"text_delta",data:{content:`Inspect file ${i}.`}},
 {type:"tool_call",data:{tool_call_id:`t${i}`,name:"read",args:{path:`src/file${i}.ts`}}},
 {type:"tool_result",data:{tool_call_id:`t${i}`,result:"Read complete"}},
 {type:"assistant_message",data:{content:`Inspect file ${i}. Done.`,id:`a${i}`}}
);
const [items,setItems]=createSignal(buildTranscript(events));
// Match the bounded conversation scroller used by the app. Without it the
// transcript deliberately renders every turn for non-scrolling embeddings.
render(()=><main id="transcript" class="scroll" style={{height:'100vh',overflow:'auto'}}><Transcript items={items()}/></main>,document.getElementById("root")!);
const projectAcrossRuns=createLocalTranscriptProjection();
let trackThinking=createThinkingBoundaryTracker();
let bufferedThinking:StreamEvent[]=[];
Object.assign(window,{transcriptHarness:{
 storedLocal:(rows:StoredEvent[],boundaries:LocalTranscriptBoundary[],current:Parameters<typeof projectLocalTranscript>[2])=>setItems(projectAcrossRuns(buildTranscript(rows.map(storedToStream).filter((event):event is StreamEvent=>event!==null)),boundaries,current)),
 transition:(canonical:StreamItem[],boundaries:LocalTranscriptBoundary[],current:Parameters<typeof projectLocalTranscript>[2])=>setItems(projectAcrossRuns(canonical,boundaries,current)),
 recover:async(canonical:StreamItem[],cuts:{id:string;before:string}[])=>{
  const host=window as any;
  host.__TAURI_INTERNALS__={invoke:async(command:string)=>{
   if(command==='local_transcript_recover')return cuts;
   throw new Error('Unexpected native command: '+command);
  }};
  try { await recoverLocalTranscript('fixture','run',canonical); }
  finally { delete host.__TAURI_INTERNALS__; }
  setItems(projectLocalTranscript(canonical,localTranscriptBoundaries('fixture'),{text:'',active:false,activities:[]}));
 },
 local:async(canonical:StreamItem[],boundaries:LocalTranscriptBoundary[],current:Parameters<typeof projectLocalTranscript>[2])=>{
  for(const cut of boundaries)await saveLocalTranscriptBoundary('fixture',cut);
  await loadLocalTranscriptBoundaries('fixture');
  setItems(projectLocalTranscript(canonical,localTranscriptBoundaries('fixture'),current));
 },
 reset:(ev:StreamEvent[])=>setItems(buildTranscript(ev)),
 legacyStart:()=>{trackThinking=createThinkingBoundaryTracker();bufferedThinking=[];setItems(buildTranscript([]));},
 legacyLive:(event:StreamEvent)=>{const tracked=trackThinking(event);bufferedThinking.push(tracked);setItems(items=>applyStreamEvent(items,tracked));},
 legacyRefresh:(history:StreamEvent[])=>{bufferedThinking=heldAfterHistory(history,bufferedThinking);setItems(buildTranscript([...history,...bufferedThinking]));},
 reconcile:(history:StreamEvent[],held:StreamEvent[])=>setItems(buildTranscript([...history,...heldAfterHistory(history,held)])),
 apply:(ev:StreamEvent)=>setItems(v=>applyStreamEvent(v,ev)),
 benchmark:async()=>{
 const renderTimes:number[]=[], replayTimes:number[]=[];
 for(let i=0;i<20;i++){
   const replayStart=performance.now(); const replay=buildTranscript(events); replayTimes.push(performance.now()-replayStart);
   const mount=document.createElement("div");mount.className="scroll";mount.style.cssText="height:900px;overflow:auto";document.body.append(mount);
   const start=performance.now();const dispose=render(()=><Transcript items={replay}/>,mount);void mount.offsetHeight;
   renderTimes.push(performance.now()-start);dispose();mount.remove();await new Promise(requestAnimationFrame);
 }
 renderTimes.sort((a,b)=>a-b);replayTimes.sort((a,b)=>a-b);
 const host=document.getElementById("transcript")!;
 const fold=host.querySelector(".st-work")!;
 (fold.querySelector("button") as HTMLButtonElement).click();
 let added=0,removed=0;
 const observer=new MutationObserver(records=>{for(const r of records){added+=r.addedNodes.length;removed+=r.removedNodes.length;}});
 observer.observe(host,{childList:true,subtree:true});
 const timings:number[]=[];
 for(let i=0;i<60;i++){
  const start=performance.now();
  setItems(v=>applyStreamEvent(v,{type:"text_delta",data:{content:`Live update ${i}`}}));
  void host.offsetHeight;
  timings.push(performance.now()-start);
  await new Promise(requestAnimationFrame);
 }
 observer.disconnect(); timings.sort((a,b)=>a-b);
 return {events:1500,updates:60,renderMedian:renderTimes[10],renderP95:renderTimes[19],replayMedian:replayTimes[10],replayP95:replayTimes[19],median:timings[30],p95:timings[57],added,removed,foldRetained:host.contains(fold),foldOpen:fold.classList.contains("open"),elements:host.querySelectorAll("*").length};
 }
}});
