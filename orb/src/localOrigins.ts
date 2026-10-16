import {getApiUrl,getJwt,connectionVersion,type Mission} from './api';
import {nativeInvoke} from './clientRuns';
// Concurrent list, queue and transcript reads share one native journal scan.
// Never cache settled rows: launches and synchronization can change them immediately.
const reads=new Map<number,Promise<Mission[]>>();
export async function localOrigins(missionId?:string):Promise<Mission[]>{
 const invoke=nativeInvoke();if(!invoke||!getJwt())return [];
 const version=connectionVersion();
 let read=reads.get(version);
 if(!read){
  read=(async()=>{
   try{const rows=await invoke('local_origin_list',{connection:{api_url:getApiUrl(),token:getJwt()}});if(version!==connectionVersion())throw new Error("Connection changed while reading local missions");return Array.isArray(rows)?rows as Mission[]:[];}
   catch(error){if(/unknown command|not found/i.test(String(error)))return [];throw error;}
  })().finally(()=>reads.delete(version));
  reads.set(version,read);
 }
 const rows=await read;
 return missionId?rows.filter(row=>row.id===missionId):rows;
}
/** Local work that Core has not accepted yet. It overrides what Core lists.
 * The shown status may be one Core confirmed, so only the journal's own run state counts;
 * a desktop build without that field never shows confirmed statuses. */
export const localPending=(mission:Mission)=>!!mission.local_sync_pending||(mission.local_run_active??mission.status==="active");
/** Local output wins while syncing; Core still owns mutable next-turn settings.
 * Otherwise a running journal's launch-time effort undoes a successful settings patch. */
export function withCoreEffort(local:Mission,core?:Mission):Mission {
 return core ? {...local,model_effort:core.model_effort,service_tier:core.service_tier,fast_mode:core.fast_mode} : local;
}
let lastObservation=0;
/** Orders requests and accepted changes made by this window, even within one millisecond. */
export const observe=()=>lastObservation=Math.max(Date.now(),lastObservation+1);
export interface Confirmation {id:string;status?:string;title?:string;deleted?:boolean;observed_at:number}
/** Persist what Core confirmed. The journal keeps the newest observation and ignores unsynchronized work. */
export async function confirmLocalOrigins(confirmations:Confirmation[]):Promise<void>{
 const invoke=nativeInvoke();if(!invoke||!getJwt()||!confirmations.length)return;
 try{await invoke('local_origin_confirm',{connection:{api_url:getApiUrl(),token:getJwt()},confirmations});}
 catch{/* The list on screen already comes from Core; an older desktop build only loses the offline copy. */}
}
/** Retire journals only after an explicit, successful user deletion. A read-side 404 is not deletion consent. */
export function confirmDeletedLocalOrigins(ids:string[],observedAt=observe()):Promise<void>{
 const unique=[...new Set(ids.filter(Boolean))];
 for(const id of unique)unlistedReads.delete(id);
 return confirmLocalOrigins(unique.map(id=>({id,deleted:true,observed_at:observedAt})));
}
/** Compare Core's answer with the journal and remember archive, restore and title changes. */
export function rememberCoreState(local:Mission[],remote:Mission[],observedAt:number):Promise<void>{
 const known=new Map(remote.map(mission=>[mission.id,mission]));
 return confirmLocalOrigins(local.flatMap(mission=>{
  const core=known.get(mission.id);
  if(!core||localPending(mission)||(core.status===mission.status&&(core.title??"")===(mission.title??"")))return [];
  // An emptied title is a title: dropping it would bring the old name back offline.
  return [{id:mission.id,status:core.status,...(typeof core.title==="string"?{title:core.title}:{}),observed_at:observedAt}];
 }));
}
/** Keep the saved local copy when Core omits it or cannot find it. An affirmative
 * Core status still controls archive visibility; pending local output wins. */
export function mergeLocalOrigins(local:Mission[],remote:Mission[],unlisted:Mission[],includeArchived=false):Mission[]{
 const known=new Map([...unlisted,...remote].map(row=>[row.id,row]));
 const pending=local.filter(localPending).map(row=>withCoreEffort(row,known.get(row.id)));
 const pendingIds=new Set(pending.map(row=>row.id)),listed=new Set(remote.map(row=>row.id));
 const recovered=local.filter(row=>!pendingIds.has(row.id)&&!listed.has(row.id))
  .map(row=>known.get(row.id)??row)
  .filter(row=>includeArchived||!HIDDEN_STATUSES.has(row.status));
 return [...pending,...remote.filter(row=>!pendingIds.has(row.id)),...recovered];
}
const HIDDEN_STATUSES=new Set(["acknowledged","completed","absorbed"]);
/** Lists leave out archived rows. Ask Core about synchronized journal missions it did not list.
 * A failed lookup, including 404, must never destroy the journal or its resume binding. */
export async function unlistedCoreState(local:Mission[],listed:Mission[],read:(id:string)=>Promise<Mission>):Promise<Mission[]>{
 const version=connectionVersion();
 if(unlistedVersion!==version){forgetUnlistedReads();unlistedVersion=version;}
 const seen=new Set(listed.map(mission=>mission.id));
 // An affirmative list response supersedes an older cached archive observation.
 for(const mission of listed)unlistedReads.delete(mission.id);
 const missing=local.filter(mission=>!seen.has(mission.id)&&!localPending(mission));
 const now=Date.now(),due=missing.filter(mission=>{const last=unlistedReads.get(mission.id);return !last||now-last.at>=(last.mission&&LIVE_STATUSES.has(last.mission.status)?UNLISTED_LIVE_MS:UNLISTED_SETTLED_MS);}).slice(0,20);
 await Promise.allSettled(due.map(async mission=>{
  let value:Mission|undefined;
  try{const result=await read(mission.id);if(result?.id===mission.id&&typeof result.status==="string")value=result;}
  catch{/* Missing or unavailable Core data leaves the local copy recoverable. */}
  if(version===connectionVersion())unlistedReads.set(mission.id,{at:Date.now(),mission:value});
 }));
 if(version!==connectionVersion())return [];
 return missing.flatMap(mission=>{const value=unlistedReads.get(mission.id)?.mission;return value?[value]:[];});
}
const UNLISTED_LIVE_MS=30_000,UNLISTED_SETTLED_MS=10*60_000;
const LIVE_STATUSES=new Set(["active","running","pending","queued","starting","resuming"]);
const unlistedReads=new Map<string,{at:number;mission?:Mission}>();
let unlistedVersion=-1;
export function forgetUnlistedReads(){unlistedReads.clear();}
