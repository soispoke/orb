import {For,Show,createMemo,createSignal} from 'solid-js';
import {canDiscardQueuedMessage,localSteeringPending,queuedLocalMessages,prioritizeQueuedMessage,removeQueuedMessage,retryQueuedMessage,sendQueuedNow} from './localMessageQueue';
import * as Ic from './icons';
import {LiveInputUnavailable} from './liveInputAvailability';
/** Follow-ups waiting for the current turn, shown like Cursor's queue: one line per
 * message, hover actions, and the row being edited marked in place. */
export function QueuedMessages(p:{mission:string;hiddenIds?:ReadonlySet<string>;busy?:boolean;editing?:string;pending?:{id:string;text:string}[];onEdit?:(row:{id:string;text:string})=>void;onCancelPending?:(id:string)=>void}){
 const storedRows=()=>queuedLocalMessages(p.mission).filter(row=>(row.waiting&&row.state!=='accepted'&&row.state!=='dispatching'||!!row.error)&&!p.hiddenIds?.has(row.id));
 const pendingRows=()=> {
  const known=new Set<string>(storedRows().map(r=>r.id));
  return (p.pending??[]).filter(item=>!known.has(item.id)&&!p.hiddenIds?.has(item.id));
 };
 const totalCount=()=>storedRows().length+pendingRows().length;
 const rows=storedRows;
 const firstQueued=createMemo(()=>rows().findIndex(row=>row.state==='queued'));
 const canSendNow=()=>firstQueued()>=0;
 const sendLabel=()=>p.busy?'Steer now':'Send now';
 const sending=(row:{id:string})=>localSteeringPending(p.mission,row.id);
 const failed=(row:{id:string;error?:string;steerToken?:string})=>!!row.error&&!row.steerToken&&!sending(row);
 const attention=()=>rows().some(failed);
 const unconfirmed=()=>rows().some(row=>row.steerToken&&!sending(row));
 const [working,setWorking]=createSignal(false),[busyIds,setBusyIds]=createSignal<Set<string>>(new Set()),[collapsed,setCollapsed]=createSignal(false),[error,setError]=createSignal('');
 const [notice,setNotice]=createSignal<{id:string;message:string}>();
 const act=async(id:string,fn:()=>Promise<unknown>)=>{if(working())return;try{setWorking(true);setError('');setNotice();await fn();}catch(e){if(e instanceof LiveInputUnavailable)setNotice({id,message:e.message});else if(!rows().some(row=>row.id===id&&row.steerToken))setError(e instanceof Error?e.message:String(e));}finally{setWorking(false);}};
 const actRow=async(id:string,fn:()=>Promise<unknown>)=>{if(busyIds().has(id))return;setBusyIds(prev=>new Set(prev).add(id));setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusyIds(prev=>{const next=new Set(prev);next.delete(id);return next;});}};
 return <Show when={totalCount()}><section class="followup-queue" classList={{collapsed:collapsed()}} aria-label="Queued messages" aria-live="polite">
  <header>
   <span class="queue-count">{totalCount()} {attention() ? "Needs attention" : rows().some(sending) ? "Sending…" : unconfirmed() ? "Delivery unconfirmed" : rows().length ? "Queued" : "Sending…"}</span>
   <Show when={canSendNow()&&!attention()&&!p.editing&&!p.busy}><span class="queue-hint"><Ic.ReturnIcon size={13}/> to Send</span></Show>
   <div class="queue-options">
    <button type="button" class="queue-collapse" aria-label={collapsed()?"Show queued messages":"Hide queued messages"} aria-expanded={!collapsed()} onClick={()=>setCollapsed(!collapsed())}><Ic.ChevronDown size={14}/></button>
   </div>
  </header>
  <Show when={!collapsed()}><ol classList={{scrollable:totalCount()>6}}>
   <For each={rows()}>{row=><li class="queue-row" classList={{editing:p.editing===row.id,failed:failed(row)}}>
    <div class="queue-line">
     <span class="queue-text" title={row.text}>{row.text}</span>
     <Show when={p.editing===row.id} fallback={<span class="queue-row-actions">
      <Show when={p.onEdit&&row.state==='queued'&&!sending(row)}><button type="button" class="queue-action-btn" aria-label={`Edit queued message: ${row.text}`} disabled={working()||busyIds().has(row.id)||!!p.editing} onClick={()=>p.onEdit!({id:row.id,text:row.text})}><Ic.PencilIcon size={14}/><span class="queue-tooltip" aria-hidden="true"><span>Edit</span><kbd>→</kbd></span></button></Show>
      <Show when={row.state==='queued'&&!sending(row)}><button type="button" class="queue-action-btn" aria-label={`${sendLabel()}: ${row.text}`} title="Send into the existing session without stopping work" disabled={working()||busyIds().has(row.id)||!!p.editing} onClick={()=>void act(row.id,()=>sendQueuedNow(p.mission,row.id))}><Ic.ArrowUpIcon size={14}/><span class="queue-tooltip" aria-hidden="true"><span>{sendLabel()}</span></span></button></Show>
      <button type="button" class="queue-action-btn" aria-label={`Remove queued message: ${row.text}`} disabled={working()||busyIds().has(row.id)||!canDiscardQueuedMessage(row)||sending(row)||p.editing===row.id} onClick={()=>void actRow(row.id,()=>removeQueuedMessage(row.id))}><Ic.TrashIcon size={14}/><span class="queue-tooltip" aria-hidden="true"><span>Delete</span></span></button>
     </span>}><span class="queue-editing">Editing</span></Show>
    </div>
    <Show when={row.state==='dispatching'}><small>{row.error?'Needs review':'Sending…'}</small></Show>
    <Show when={sending(row)}><small role="status">Sending to the running session… Work continues.</small></Show>
    <Show when={row.error&&!sending(row)}><small role={row.steerToken?"status":"alert"}>{row.error}</small><Show when={!row.steerToken&&(row.state==='error'||row.state==='dispatching'||row.interrupted)}><button type="button" class="queue-send-now" disabled={working()||busyIds().has(row.id)} onClick={()=>void actRow(row.id,()=>retryQueuedMessage(row.id))}>Retry</button></Show></Show>
   </li>}</For>
   <For each={pendingRows()}>{row=><li class="queue-row">
    <div class="queue-line">
     <span class="queue-text" title={row.text}>{row.text}</span>
     <Show when={p.onCancelPending} fallback={<span class="queue-editing">Sending…</span>}>
      <span class="queue-row-actions">
       <button type="button" class="queue-action-btn" aria-label={`Remove queued message: ${row.text}`} onClick={()=>p.onCancelPending!(row.id)}><Ic.TrashIcon size={14}/><span class="queue-tooltip" aria-hidden="true"><span>Delete</span></span></button>
      </span>
     </Show>
    </div>
   </li>}</For>
  </ol></Show>
  <Show when={notice()&&rows().some(row=>row.id===notice()!.id&&row.state==='queued')}><p role="status">{notice()!.message}</p></Show>
  <Show when={error()&&!rows().some(row=>row.error?.includes(error()))}><p role="alert">{error()}</p></Show>
 </section></Show>;
}
