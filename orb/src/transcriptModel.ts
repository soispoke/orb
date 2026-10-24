import {sessionEndAgent, sessionEndTool, UNCONFIRMED_AGENT} from './agentSessionStatus';
import type { DraftImage } from "./imageAttachments";
import { deferredMessages } from "./deferredMessages";
import { isGeneratedRemoteJobStatus, type StreamEvent } from "./stream";

export type StreamItem =
  | { kind: "user"; key: string; text: string; images?: DraftImage[]; messageId?: string; source?: string; queued?: boolean; attached?: boolean; receipt?: boolean; continuityRetry?: boolean }
  | { kind: "subagent"; key: string; text: string; agent: import("./Subagents").Subagent }
  | { kind: "think"; key: string; text: string; done: boolean }
  | { kind: "text"; key: string; text: string; live: boolean; sourceEventId?: string }
  | { kind: "error"; key: string; text: string; terminal?: boolean; cancelled?: boolean; cancelling?: boolean }
  | {
      kind: "tool";
      key: string;
      callId: string;
      startedAt?: number;
      finishedAt?: number;
      name: string;
      args: unknown;
      result?: unknown;
      done: boolean;
      unresolved?: boolean;
    };


const str = (v: unknown): string => typeof v === "string" ? v : v == null ? "" : String(v);
const states = new WeakMap<StreamItem[], TranscriptReducer>();

/** The producer owns text_delta_latest for an entire assistant response,
 * including tool boundaries. Other text_op bubbles have independent identities.
 * Offsets are Rust Unicode scalar indices, not JavaScript UTF-16 offsets. */
export class TranscriptReducer {
  items: StreamItem[] = [];
  private users = new Map<string, number>();
  private tools = new Map<string, number>();
  private bubbles = new Map<string, number>();
  // Producer offsets remain relative to its full response, even when a user
  // question splits that response into two chronological display segments.
  private segments = new Map<string, {prefix: string; full: string}>();
  private seen = new Set<string>();
  /** Long finished thinking already shown in this chat. The live stream can
   * repeat an older block after a later tool call, across a mid-run message;
   * a long block never recurs by chance (short ones, like an ETA, may). */
  private shownThinking = new Set<string>();
  private static readonly REPEATABLE_THINKING = 200;
  private seq = new Map<string, number>();
  private revisions = new Map<string, number>();
  private next = 0;
  private lastFinal: number | undefined;
  private identity:string|undefined;
  private key(kind: string) { return this.identity ? `${kind}:${this.identity}:${++this.nextForEvent}` : `${kind}-${++this.next}`; }
  private nextForEvent=0;
  private response=0;
  private textKey(bubble:string,fallback:string):string {
    let user: Extract<StreamItem,{kind:'user'}>|undefined;
    for(let i=this.items.length-1;i>=0;i--){const item=this.items[i];if(item.kind==='user'&&!item.queued){user=item;break;}}
    // Transport IDs change between live operations, persisted snapshots, and
    // canonical rows. Keep the display segment tied to its delivered question.
    if(bubble.startsWith('codex:'))return `text:${JSON.stringify([bubble,user?.key??'initial'])}`;
    if(bubble==='text_delta_latest'&&user)return `text:${JSON.stringify([bubble,user.key,this.response])}`;
    return fallback;
  }
  private put(index: number, item: StreamItem) { this.items[index] = item; }
  private dismissStaleCancellation() {
    const remove = new Set<number>();
    this.items.forEach((item, index) => { if (item.kind === "error" && item.cancelling) remove.add(index); });
    if (!remove.size) return;
    const positions = new Map<number, number>();
    const next = this.items.filter((_, index) => {
      if (remove.has(index)) return false;
      positions.set(index, positions.size);
      return true;
    });
    for (const map of [this.users, this.tools, this.bubbles]) for (const [key, index] of map) {
      const position = positions.get(index);
      if (position === undefined) map.delete(key); else map.set(key, position);
    }
    if (this.lastFinal !== undefined) this.lastFinal = positions.get(this.lastFinal);
    this.items = next;
  }
  /** A tool call or thought followed this bubble: the producer moved on to its next message. */
  private workSince(index: number) { return this.items.some((item, i) => i > index && (item.kind === "tool" || item.kind === "think")); }
  private placeText(bubble:string,item:Extract<StreamItem,{kind:'text'}>):number {
    let index=this.items.length;
    item={...item,key:this.textKey(bubble,item.key)};
    if(bubble.startsWith('antigravity:')) {
      const [,conversation,,step]=bubble.split(':');
      const lastUser=this.items.reduce((last,item,i)=>item.kind==='user'&&!item.queued?i:last,-1);
      const boundary=this.items.findIndex((item,i)=>i>lastUser&&item.kind==='tool'&&item.callId.startsWith(conversation+':')&&Number(item.callId.slice(conversation.length+1))>Number(step));
      if(boundary>=0)index=boundary;
      item={...item,key:`text:${bubble}`};
    }
    for(const map of [this.users,this.tools,this.bubbles])for(const [key,i] of map)if(i>=index)map.set(key,i+1);
    if(this.lastFinal!=null&&this.lastFinal>=index)this.lastFinal++;
    this.items.splice(index,0,item);
    this.bubbles.set(bubble,index);
    return index;
  }

  removeQueued(ids: ReadonlySet<string>) {
    const positions = new Map<number, number>();
    const next = this.items.filter((item, index) => {
      if (item.kind === 'user' && item.queued && item.messageId && ids.has(item.messageId)) return false;
      positions.set(index, positions.size); return true;
    });
    if (next.length === this.items.length) return;
    for (const map of [this.users, this.tools, this.bubbles]) for (const [key, index] of map) {
      const position = positions.get(index);
      if (position === undefined) map.delete(key); else map.set(key, position);
    }
    if (this.lastFinal !== undefined) this.lastFinal = positions.get(this.lastFinal);
    this.items = next;
  }

  private close() {
    for (const index of this.bubbles.values()) {
      const item = this.items[index];
      if (item?.kind === "text" && item.live) this.put(index, { ...item, live: false });
    }
    for (let i=0;i<this.items.length;i++) {
      const item=this.items[i];
      if(item.kind==='tool'&&!item.done)this.put(i,{...item,done:true,unresolved:true});
      if(item.kind==='think'&&!item.done)this.put(i,{...item,done:true});
    }
    this.bubbles.clear();
    this.segments.clear();
    this.response++;
  }
  private beginUserTurn() {
    this.response=0;
    // Freeze what the reader already saw above the question. Further text
    // belongs below it, without repeating a cumulative snapshot's old prefix.
    // This is presentation only: running tools remain running.
    for (const [bubble, index] of this.bubbles) {
      const item = this.items[index];
      if (item?.kind === "text" && item.live) {
        const full=this.segments.get(bubble)?.full ?? item.text;
        this.segments.set(bubble,{prefix:full,full});
        this.put(index,{...item,live:false});
      } else this.segments.delete(bubble);
    }
    this.bubbles.clear();
    this.lastFinal = undefined;
  }
  apply(ev: StreamEvent) {
    this.identity=ev.eventId??(ev.storedId!==undefined?`stored:${ev.storedId}`:ev.sequence!==undefined?`seq:${ev.sequence}`:undefined);this.nextForEvent=0;
    // The persisted text snapshot keeps its row/event ID as its sequence advances.
    // Each revision must replay; the same row can also serve a later user turn.
    if (ev.type === "text_delta" && ev.sequence != null) this.identity = `text-revision:${ev.sequence}`;
    const d = ev.data;
    // Status notifications are not assistant completions: do not close live text/tools.
    if (ev.type === "assistant_message" && d.success !== false && isGeneratedRemoteJobStatus({content: str(d.content), metadata: d})) return;
    // A message has one identity and a monotonic queued -> delivered lifecycle.
    // Process it before event dedupe and channel sequence checks: receipt, queue
    // snapshot, stored history and SSE may arrive in any order.
    if (ev.type === "user_message") {
      const parts = deferredMessages(str(d.content), d.source, d.messages);
      if (parts) {
        for (const part of parts) this.apply({ type: "user_message", data: { ...part, queued: d.queued === true } });
        return;
      }
      const messageId = typeof d.id === "string" ? d.id : ev.eventId;
      const queued = d.queued === true;
      const source = typeof d.source === "string" ? d.source : undefined;
      if (!messageId && ev.sequence != null) {
        const legacyIdentity = `user:${ev.sequence}:${queued}`;
        if (this.seen.has(legacyIdentity)) return;
        this.seen.add(legacyIdentity);
      }
      const index = messageId ? this.users.get(messageId) : undefined;
      const previous = index == null ? undefined : this.items[index];
      if (previous?.kind === "user" && index != null) {
        if (source && source !== previous.source) this.put(index, { ...previous, source });
        if (!previous.queued || queued) {
          if (previous.receipt && d.receipt !== true) this.put(index, { ...previous, source: source ?? previous.source, text: str(d.content) || previous.text, receipt: false });
          return;
        }
        this.beginUserTurn();
        // A queued row may precede text that arrived while it was waiting.
        // Delivery places it after that response without changing its identity.
        this.items.splice(index, 1);
        for (const map of [this.users, this.tools, this.bubbles]) {
          for (const [key, position] of map) if (position > index) map.set(key, position - 1);
        }
        this.users.set(messageId!, this.items.length);
        this.items.push({ ...previous, source: source ?? previous.source, text: str(d.content) || previous.text, queued: false, receipt: d.receipt === true });
        return;
      }
      if (!queued) { this.beginUserTurn(); }
      if (messageId) this.users.set(messageId, this.items.length);
      this.items.push({ kind: "user", key: messageId ? `user:${messageId}` : this.key("user"), text: str(d.content), messageId, source, queued, attached: d.attached === true, receipt: d.receipt === true });
      return;
    }
    const id = ev.eventId ?? (typeof d.id === "string" ? d.id : undefined);
    const identity = ev.type === "text_delta" && ev.sequence != null ? `text-revision:${ev.sequence}` : d.canonical === true && ev.sequence != null ? `canonical:${ev.sequence}` : id ? `${ev.type}:${id}` : ev.sequence != null ? `stored:${ev.sequence}:${ev.type}` : undefined;
    if (identity && this.seen.has(identity)) return;
    if (identity) this.seen.add(identity);
    const bubble = str(d.bubble_id) || "text_delta_latest";
    const channel = ev.type === "subagent_update" ? `subagent_update:${str((d.agent as {id?: unknown} | undefined)?.id)}` : `${ev.type}:${bubble}`;
    if (ev.sequence != null) {
      if (ev.sequence < (this.seq.get(channel) ?? -1)) return;
      this.seq.set(channel, ev.sequence);
    }
    // A cancellation request is provisional. If the producer emits another
    // tool/text/thinking event afterward, the run continued and the red
    // "Stopping mission" card must not remain as a false terminal warning.
    if (["tool_call", "tool_result", "text_delta", "thinking", "assistant_message", "subagent_update"].includes(ev.type)) {
      this.dismissStaleCancellation();
    }
    const last = this.items.at(-1);
    switch (ev.type) {
      case "subagent_update": {
        const incoming = d.agent as import("./Subagents").Subagent;
        const stale = incoming?.status === 'failed' && sessionEndAgent(incoming.detail);
        const agent = stale ? {...incoming, status: 'unknown', detail: UNCONFIRMED_AGENT, finishedAt: undefined} : incoming;
        if (!agent || typeof agent.id !== "string" || typeof agent.description !== "string") break;
        const index = this.items.findIndex(i => i.kind === "subagent" && i.agent.id === agent.id);
        const previous = index < 0 ? undefined : this.items[index];
        const old = previous?.kind === "subagent" ? previous.agent : undefined;
        if (stale && old && old.status !== 'unknown') break;
        if (old && ["completed", "finished", "failed", "stopped"].includes(old.status) && ["running", "waiting", "queued", "unknown"].includes(agent.status)) break;
        const parsed = Date.parse(ev.timestamp ?? "");
        const time = Number.isFinite(parsed) ? parsed : undefined;
        const terminal = ["completed", "finished", "failed", "stopped"].includes(agent.status);
        const enriched = {...agent, startedAt: old?.startedAt ?? agent.startedAt ?? (agent.status === "running" ? time : undefined), finishedAt: old?.finishedAt ?? agent.finishedAt ?? (terminal ? time : undefined)};
        const item: StreamItem = {kind: "subagent", key: `subagent:${agent.id}`, text: agent.description, agent: enriched};
        if (index < 0) this.items.push(item); else this.put(index, item);
        break;
      }
      case "text_delta":
      case "text_op": {
        let index = this.bubbles.get(bubble);
        const previous = index == null ? undefined : this.items[index];
        const segment=this.segments.get(bubble);
        let text = segment?.full ?? (previous?.kind === "text" ? previous.text : "");
        let live = previous?.kind === "text" ? previous.live : true;
        let snapshot: string | undefined;
        if (ev.type === "text_delta") {
          const next = str(d.content);
          if (d.mode === "delta") {
            text += next;
            live = true;
          } else {
            snapshot = next;
            text = next;
            live = true;
          }
        } else {
          // Positions count code points. Almost every op appends, which needs
          // no per-character copy of the bubble: on a long reply that copy
          // took the reducer to half a second per batch.
          let chars: string[] | undefined;
          const length = () => { chars ??= Array.from(text); return chars.length; };
          const splice = (start: number, remove: number, insert: string) => {
            chars ??= Array.from(text);
            chars.splice(Math.max(0, start), Math.max(0, remove), insert);
            text = chars.join("");
            chars = undefined;
          };
          for (const op of (Array.isArray(d.ops) ? d.ops : []) as Record<string, unknown>[]) {
            if (op.type === "snapshot") {
              const revision = Number(op.revision);
              if (!Number.isFinite(revision) || revision <= (this.revisions.get(bubble) ?? -1)) return;
              this.revisions.set(bubble, revision);
              text = str(op.text); chars = undefined; snapshot = text;
            } else if (op.type === "insert") {
              // This synthetic bubble carries a full snapshot even on reconnect,
              // when a fresh producer buffer emits insert(0, accumulated_text).
              if (bubble === "text_delta_latest" && op.pos === 0) { snapshot = str(op.text); text = snapshot; chars = undefined; }
              // UTF-16 length bounds the code-point count, so this needs no scan.
              else if (typeof op.pos !== "number" || op.pos >= text.length || op.pos >= length()) { text += str(op.text); chars = undefined; }
              else splice(op.pos, 0, str(op.text));
            } else if (op.type === "replace") {
              const range = Array.isArray(op.range) ? op.range as number[] : [0, length()];
              if (bubble === "text_delta_latest" && range[0] === 0) { snapshot = str(op.text); text = snapshot; chars = undefined; }
              else splice(range[0], range[1] - range[0], str(op.text));
            } else if (op.type === "finalize") live = false;
          }
        }
        if(segment) {
          if(text.startsWith(segment.prefix)){segment.full=text;text=text.slice(segment.prefix.length);}
          else if(segment.prefix.startsWith(text))return; // late unchanged prefix
          else {segment.prefix="";segment.full=text;} // a new producer response
        }
        // Claude's snapshot restarts with each assistant message, so after a
        // tool call the next message's text does not extend the shown one.
        // Never erase or shrink what the reader sees: a new message continues
        // in its own bubble, below the work that preceded it.
        if (bubble === "text_delta_latest" && snapshot != null && previous?.kind === "text" && previous.text && index != null && this.workSince(index) && !text.startsWith(previous.text)) {
          if (previous.text.startsWith(text)) return;
          if (previous.live) this.put(index, { ...previous, live: false });
          this.segments.delete(bubble);
          index = undefined; live = true; this.response++;
        }
        if (index == null && bubble === "text_delta_latest" && this.lastFinal != null) {
          const finalized = this.items[this.lastFinal];
          if (finalized?.kind === "text" && !finalized.live && snapshot != null && finalized.text.startsWith(snapshot)) {
            // Recovery may replay an unsequenced live prefix after its durable
            // final. A delivered user turn resets lastFinal, so new replies
            // with identical text remain independent.
            return;
          }
        }
        if (index == null) {
          if (!text) return;
          index=this.placeText(bubble,{kind:"text",key:this.key("text"),text,live,sourceEventId:ev.eventId});
        } else if (previous?.kind === "text" && (previous.text !== text || previous.live !== live)) this.put(index,{...previous,text,live});
        return;
      }
      case "assistant_message": {
        const finalBubble=str(d.bubble_id)||"text_delta_latest";
        const full=str(d.content),segment=this.segments.get(finalBubble);
        const text=segment&&full.startsWith(segment.prefix)?full.slice(segment.prefix.length):full;
        if(segment)segment.full=full;
        if(d.canonical===true){
          if(typeof d.revision === 'number') {
            if(d.revision < (this.revisions.get(finalBubble) ?? -1)) return;
            this.revisions.set(finalBubble,d.revision);
          }
          // Canonical rows finalize one identified bubble; other native bubbles
          // must remain distinct. Keep it available for the turn's final event.
          const index=this.bubbles.get(finalBubble) ?? (finalBubble==="text_delta_latest" ? this.lastFinal : undefined);
          const previous=index==null ? undefined : this.items[index];
          if(previous?.kind==="text"&&index!=null){this.put(index,{...previous,text:text||previous.text,live:false,sourceEventId:ev.eventId??previous.sourceEventId});this.bubbles.set(finalBubble,index);}
          else if(text){this.placeText(finalBubble,{kind:"text",key:this.key("text"),text,live:false,sourceEventId:ev.eventId});}
          return;
        }
        const index=this.bubbles.get(finalBubble);
        const previous=index == null ? undefined : this.items[index];
        const native = [...this.bubbles].filter(([id])=>id.startsWith('antigravity:') || id.startsWith('codex:')).sort((a,b)=>a[1]-b[1]).map(([,i])=>this.items[i]).filter((i):i is Extract<StreamItem,{kind:'text'}>=>i?.kind==='text');
        const trimmed = text.trim();
        const isNativeReceipt = native.length > 0 && (trimmed === native.map(i=>i.text).join('').trim() || trimmed === native.at(-1)!.text.trim());
        const finalKey=this.textKey(finalBubble,this.key("text"));
        this.close();
        if (d.success === false) {
          const cancelled = text.trim().toLowerCase() === "cancelled";
          const failure: Extract<StreamItem, {kind:"error"}> = {kind:"error",key:this.key("error"),text:text||"Mission failed",terminal:true,cancelled};
          const previous = this.items.at(-1);
          if (previous?.kind === "error" && (previous.cancelling && cancelled || /^unknown error$/i.test(previous.text.trim()) || previous.text === failure.text)) {
            this.put(this.items.length - 1, {...failure, key: previous.key});
          } else this.items.push(failure);
          return;
        }
        if(isNativeReceipt) return;
        // Claude's result is its last message only; an earlier message's
        // paragraph stays, and the result reads after the work since then.
        const earlier=finalBubble==="text_delta_latest"&&previous?.kind==="text"&&index!=null&&this.workSince(index)&&text.trim()&&!text.includes(previous.text.trim())&&!previous.text.startsWith(text.trim());
        if(previous?.kind === "text" && index != null && !earlier){this.put(index,{...previous,text:text||previous.text,live:false,sourceEventId:ev.eventId??previous.sourceEventId});this.lastFinal=index;}
 else if(text){this.lastFinal=this.items.length;this.items.push({kind:"text",key:earlier?this.textKey(finalBubble,this.key("text")):finalKey,text,live:false,sourceEventId:ev.eventId});}
        return;
      }
      case "thinking": {
        const text=str(d.content),done=d.done===true;
        if(!text)return;
        // A block's final copy can arrive after the tool call that followed it
        // (Claude finalizes at the end of the assistant message). Complete the
        // streamed copy in place, and never repeat a finished block in this turn.
        const long=text.trim().length>=TranscriptReducer.REPEATABLE_THINKING;
        if(done&&long&&this.shownThinking.has(text.trim()))return;
        for(let i=this.items.length-1;i>=0;i--){
          const item=this.items[i];
          if(item.kind==="user"&&!item.queued)break;
          if(item.kind!=="think")continue;
          if(item.done&&item.text===text)return;
          if(done&&!item.done&&(text.startsWith(item.text)||item.text.startsWith(text))){this.put(i,{...item,text,done});if(long)this.shownThinking.add(text.trim());return;}
        }
        // A delayed final belongs to the matching streamed block, which may
        // precede a tool and a newer thought. Never replace that newer thought
        // merely because it happens to be the last row.
        if(!done&&last?.kind==="think"&&!last.done){this.put(this.items.length-1,{...last,text});return;}
        this.items.push({kind:"think",key:this.key("think"),text,done});
        if(done&&long)this.shownThinking.add(text.trim());
        return;
      }
      case "tool_call":
      case "tool_result": {
        const callId=str(d.tool_call_id), index=this.tools.get(callId);
        const parsedTime = Date.parse(ev.timestamp ?? "");
        const time = Number.isFinite(parsedTime) ? parsedTime : undefined;
        const previous = index == null ? undefined : this.items[index];
        const recovery = sessionEndTool(str(d.name) || (previous?.kind === 'tool' ? previous.name : ''), d.result);
        const result = recovery ? {status: 'unknown', message: UNCONFIRMED_AGENT} : d.result;
        if(index!=null){
          const old=this.items[index];
          if(old.kind==="tool"&&ev.type==="tool_result")this.put(index,{...old,result,done:true,unresolved:!!recovery,finishedAt:recovery ? undefined : old.finishedAt ?? time});
          else if(old.kind==="tool"&&ev.type==="tool_call")this.put(index,{...old,name:str(d.name)||old.name,args:d.args??old.args,startedAt:old.startedAt ?? time});
          return;
        }
        this.tools.set(callId,this.items.length);
        this.items.push({kind:"tool",key:`tool:${callId}`,callId,...(ev.type==="tool_call"?{startedAt:time}:{finishedAt:time}),name:str(d.name)||"tool",args:d.args??null,...(ev.type==="tool_result"?{result,unresolved:!!recovery}:{}),done:ev.type==="tool_result"});return;
      }
      case "error": {
        const message = str(d.message);
        const cancelling = /^Parallel mission [0-9a-f-]+ cancellation requested$/i.test(message);
        // This is an acknowledgement of a stop request, not a terminal
        // failure. Rendering it as an error makes the red card reappear every
        // time history is reconciled while the request is still being drained.
        // A later cancelled/failed assistant result remains visible below.
        if (cancelling) return;
        const previous = this.items.at(-1);
        // A late generic transport notice must not hide the concrete final failure.
        if (previous?.kind === "error" && (previous.text === message || previous.terminal && /^unknown error$/i.test(message.trim()))) return;
        if (!cancelling) this.close();
        this.items.push({kind:"error",key:this.key("error"),text:cancelling ? "Cancellation requested" : message,...(cancelling ? {cancelling:true,terminal:true} : {})});
        return;
      }
      case "mission_status_changed": {
        const status = str(d.status).toLowerCase();
        if (["completed", "failed", "not_feasible", "interrupted", "cancelled", "canceled"].includes(status)) {
          this.close();
        }
        if (["failed", "not_feasible", "interrupted", "cancelled", "canceled", "paused"].includes(status)) {
          for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            if (item.kind === "subagent" && ["running", "waiting", "queued"].includes(item.agent.status))
              this.put(i, {...item, agent: {...item.agent, status: "unknown"}});
          }
        }
        const summary = str(d.summary ?? d.content).trim();
        if (["failed", "not_feasible"].includes(status) && summary) {
          const lastUser = this.items.reduce((last, item, idx) => item.kind === "user" && !item.queued ? idx : last, -1);
          // The harness already reported the concrete failure; the status summary
          // ("Remote node 'x' finished") would only add a second, vaguer card.
          const alreadyShown = this.items.slice(lastUser + 1).some(item => item.kind === "error" && (item.terminal || item.text.trim() === summary));
          if (!alreadyShown) {
            this.items.push({ kind: "error", key: this.key("error"), text: summary, terminal: true });
          }
        }
        return;
      }
    }
  }
}

/**
 * Punctuation that can never be an answer on its own. Deliberately narrow:
 * `---`, `***`, `|`, backticks and brackets are all meaningful Markdown and are
 * not listed, so real content is never at risk.
 */
const FILLER_ONLY = /^[.\u2026,;]+$/;

/**
 * A finalized assistant bubble holding nothing but filler punctuation, with
 * real output still to come.
 *
 * Asking OpenCode "What's the status of the Pareto audit?" produced a bare `.`
 * between two batches of tool calls, before the real answer — rendered as its
 * own paragraph, and splitting what was one stretch of work into "Worked 5
 * tools" and "Worked 1 tool". The source of the reported live-only emission was not retained in the
 * persisted events. Only finalized bubbles are candidates here; a live
 * prefix must remain free to grow into text.
 *
 * Three conditions keep this from eating anything real:
 *  - `live` bubbles are never hidden, so a `.` that is the first token of a
 *    sentence still being streamed stays and grows normally;
 *  - something must come after it, so if `.` is all the agent ever said the
 *    user sees it rather than an empty transcript;
 *  - only sentence punctuation counts, so code, rules and tables are untouched.
 *
 * Presentation only — the underlying items, and the events behind them, are
 * unchanged.
 */
export function isFillerBubble(item: StreamItem, index: number, items: StreamItem[]): boolean {
  if (item.kind !== "text" || item.live) return false;
  if (!FILLER_ONLY.test(item.text.trim())) return false;
  // An error is not an answer: it must not license hiding the only output there
  // was. Only real text that followed does.
  for (const next of items.slice(index + 1)) {
    if (next.kind === "user" || next.kind === "error") return false;
    if (next.kind === "text" && next.text.trim() && !FILLER_ONLY.test(next.text.trim())) return true;
  }
  return false;
}

/** The transcript as shown: filler bubbles dropped, everything else intact. */
export function withoutFiller(items: StreamItem[]): StreamItem[] {
  const keep = items.filter((item, index) => !isFillerBubble(item, index, items));
  return keep.length === items.length ? items : keep;
}

type UserItem = Extract<StreamItem, {kind: "user"}>;
const continuityRetries = new WeakMap<UserItem, UserItem>();

/** Keep the original prompt visible when continuity recovery immediately retries
 * it. Require the native failure and a whole-prompt match, not merely similar
 * text. Any intervening work, changed source or undelivered input breaks the
 * relationship. The stored messages and reducer items remain untouched. */
function presentContinuityRetries(items: StreamItem[]): StreamItem[] {
  let prompt: UserItem | undefined;
  let continuityFailed = false;
  return items.map(item => {
    if (item.kind === "error" && item.terminal && item.text.includes("codex_continuity_unresolved_tools:")) {
      continuityFailed = true;
      return item;
    }
    const retry = item.kind === "user" && !item.queued && !item.attached && !item.images?.length
      && continuityFailed && prompt && prompt.text.length > 0 && item.source === prompt.source
      && (item.text === prompt.text || item.text.startsWith(prompt.text + "\n\nContinuity reconciliation:"));
    prompt = item.kind === "user" && !item.queued && !item.attached && !item.images?.length ? item : undefined;
    continuityFailed = false;
    if (!retry || item.kind !== "user") return item;
    // Preserve identity across stream updates so expanded details stay open.
    let projected = continuityRetries.get(item);
    if (!projected) {
      projected = {...item, continuityRetry: true};
      continuityRetries.set(item, projected);
    }
    return projected;
  });
}

/** A delivered follow-up supersedes the previous attempt's terminal notice.
 * Keep the raw history intact, and do not dismiss failures for queued input. */
export function visibleTranscript(items: StreamItem[]): StreamItem[] {
  let lastDelivered = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "user" && !item.queued && !item.attached) {
      lastDelivered = i;
      break;
    }
  }
  return withoutFiller(presentContinuityRetries(items).filter((item, index) =>
    !(item.kind === "error" && item.terminal && index < lastDelivered),
  ));
}

export function buildTranscript(events: StreamEvent[]): StreamItem[] {
  const reducer=new TranscriptReducer();
  for(const event of events)reducer.apply(event);
  states.set(reducer.items,reducer);
  return reducer.items;
}

export function applyStreamEvent(items: StreamItem[], event: StreamEvent): StreamItem[] {
  return applyStreamEvents(items, [event]);
}

/** One copy per transport batch; reducer ordering and deduplication are unchanged. */
export function applyStreamEvents(items: StreamItem[], events: StreamEvent[]): StreamItem[] {
  if (!events.length) return items;
  let reducer=states.get(items);
  if(!reducer){
    if(items.length)throw new Error("Transcript must originate from buildTranscript");
    reducer=new TranscriptReducer();
  }
  reducer.items=items.slice();
  for (const event of events) reducer.apply(event);
  // An event that changed nothing (activity, status, a duplicate) keeps the
  // array identity: a new one would re-run every memo and the turn list.
  if(reducer.items.length===items.length&&reducer.items.every((item,index)=>item===items[index])){reducer.items=items;states.set(items,reducer);return items;}
  states.set(reducer.items,reducer);
  return reducer.items;
}

/** Queue reconciliation must preserve reducer identity and every live index. */
export function removeQueuedMessages(items: StreamItem[], ids: ReadonlySet<string>): StreamItem[] {
  if (!ids.size || !items.length) return items;
  const reducer = states.get(items);
  if (!reducer) throw new Error("Transcript must originate from buildTranscript");
  reducer.items = items;
  reducer.removeQueued(ids);
  states.set(reducer.items, reducer);
  return reducer.items;
}
