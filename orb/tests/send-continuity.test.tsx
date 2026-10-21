import {afterEach,beforeEach,expect,it,vi} from 'vitest';
it.each(['before','after'] as const)('honors acceptance arriving %s a failed HTTP response without a stale Retry notice',async timing=>{
 const {sendMissionMessage,getMission}=await import('../src/api');
 vi.mocked(sendMissionMessage).mockClear();
 const mission={id:`receipt-${timing}`,status:'awaiting_user',history:[],created_at:'',updated_at:''};
 vi.mocked(getMission).mockResolvedValue(mission);
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json([],{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false','X-Max-Sequence':'0'}})));
 let reject!:(error:Error)=>void;
 let messageId='';
 vi.mocked(sendMissionMessage).mockImplementationOnce((_mission,_text,_attachments,id)=>{
  messageId=id!;
  return new Promise((_resolve,fail)=>{reject=fail;});
 });
 render(()=><NativeMissionView id={mission.id} initial={mission}/>);
 const {fireEvent}=await import('@solidjs/testing-library');
 const input=screen.getByPlaceholderText('Send follow-up') as HTMLTextAreaElement;
 fireEvent.input(input,{target:{value:'Continue the hunt'}});fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>expect(reject).toBeTypeOf('function'));
 const confirm=()=>state.event!({type:'user_message',data:{id:messageId,content:'Continue the hunt',queued:false}});
 if(timing==='before')confirm();
 reject(new Error('Request timed out'));
 if(timing==='after'){
  await screen.findByRole('button',{name:'Retry'});
  confirm();
 }
 await waitFor(()=>expect(input.readOnly).toBe(false));
 await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
 expect(screen.queryByRole('button',{name:'Retry'})).toBeNull();
 expect(screen.getAllByText('Continue the hunt')).toHaveLength(1);
 expect(sendMissionMessage).toHaveBeenCalledTimes(1);
});

import {render,screen,waitFor} from '@solidjs/testing-library';
import {createSignal} from 'solid-js';
import {NativeMissionView} from '../src/App';
import type {Mission} from '../src/api';
it('rechecks Core ownership before sending from an obsolete local journal without a binding',async()=>{
 const {sendMissionMessage,getMission}=await import('../src/api');
 const local={id:'moved-send',status:'awaiting_user',history:[],tags:['placement:client'],created_at:'',updated_at:''};
 const remote={...local,tags:[],backend:'codex',model_override:'gpt-6-astra'};
 let confirmed=false;
 vi.mocked(getMission).mockImplementation(async(_id,requireCore)=>{confirmed ||= !!requireCore;return confirmed?remote:local;});
 vi.mocked(sendMissionMessage).mockImplementationOnce(async(_id,_text,_attachments,id)=>({id:id!,queued:false}));
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json([],{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false','X-Max-Sequence':'0'}})));
 render(()=><NativeMissionView id={local.id} initial={local}/>);
 const {fireEvent}=await import('@solidjs/testing-library');
 const input=screen.getByPlaceholderText('Send follow-up');
 fireEvent.input(input,{target:{value:'Keep going on Core'}});fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>expect(sendMissionMessage).toHaveBeenCalledTimes(1));
 expect(getMission).toHaveBeenCalledWith(local.id,true);
 expect(screen.queryByRole('alert')).toBeNull();
 await waitFor(()=>expect(screen.getAllByText('Keep going on Core')).toHaveLength(1));
});
beforeEach(()=>{vi.clearAllMocks();Object.defineProperty(HTMLElement.prototype,'scrollTo',{configurable:true,value:vi.fn()});});
const state=vi.hoisted(()=>({event:undefined as undefined|((event:any)=>void)}));
vi.mock('../src/stream',async()=>({...await vi.importActual('../src/stream'),streamMission:(_id:string,receive:(event:any)=>void)=>{state.event=receive;return ()=>{};}}));
vi.mock('../src/api',async()=>({...await vi.importActual('../src/api'),sendMissionMessage:vi.fn(),sendQueuedMessageNow:vi.fn(async()=>false),getMission:vi.fn(async()=>({id:'accepted',status:'active',history:[],created_at:'',updated_at:''}))}));
afterEach(()=>{vi.unstubAllGlobals();state.event=undefined;});
it('keeps the initial bubble mounted across native identity allocation and canonical receipt',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json([])));
 const [id,setId]=createSignal('');
 const [mission,setMission]=createSignal<Mission>();
 const receipt={messageKey:'draft:one',prompt:'Keep this message visible',nodeId:'core',destination:'Core'};
 const view=render(()=><NativeMissionView id={id()} initial={mission()} launch={receipt}/>);
 const node=view.container.querySelector('.user');expect(node?.textContent).toContain(receipt.prompt);
 expect(state.event).toBeUndefined();
 setMission({id:'accepted',status:'active',history:[],created_at:'',updated_at:''});setId('accepted');
 await waitFor(()=>expect(state.event).toBeTypeOf('function'));
 state.event!({type:'user_message',data:{id:'canonical',content:receipt.prompt}});
 await waitFor(()=>expect(screen.getAllByText(receipt.prompt)).toHaveLength(1));
 expect(view.container.querySelector('.user')).toBe(node);
});
it('keeps the failed launch bubble in place and offers retry',()=>{
 const [error,setError]=createSignal<string>();const retry=vi.fn();
 const view=render(()=><NativeMissionView id="" launch={{messageKey:'draft:error',prompt:'Retain failed message',nodeId:'local',destination:'This computer'}} launchError={error()} onRetryLaunch={retry}/>);
 const node=view.container.querySelector('.user');setError('Connection unavailable');
 expect(view.container.querySelector('.user')).toBe(node);
 screen.getByRole('button',{name:'Retry'}).click();expect(retry).toHaveBeenCalledOnce();
});

it('keeps a follow-up visible through a failed request and retries with the same identity',async()=>{
 const {sendMissionMessage,getMission}=await import('../src/api');
 vi.mocked(getMission).mockResolvedValue({id:'followup',status:'awaiting_user',history:[],created_at:'',updated_at:''});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json([],{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false','X-Max-Sequence':'0'}})));
 let reject!:(e:Error)=>void;
 vi.mocked(sendMissionMessage).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
 vi.mocked(sendMissionMessage).mockImplementationOnce(async(_id,_text,_attachments,id)=>({id:id!,queued:false}));
 const view=render(()=><NativeMissionView id="followup" initial={{id:'followup',status:'awaiting_user',history:[],created_at:'',updated_at:''}}/>);
 const input=screen.getByPlaceholderText('Send follow-up') as HTMLTextAreaElement;
 const {fireEvent}=await import('@solidjs/testing-library');
 fireEvent.input(input,{target:{value:'Keep my follow-up'}});fireEvent.keyDown(input,{key:'Enter'});
 const node=view.container.querySelector('.user');expect(node?.textContent).toContain('Keep my follow-up');
 await waitFor(()=>expect(reject).toBeTypeOf('function'));
 reject(new Error('Network unavailable'));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Retry'})).toBeDefined());
 expect(view.container.querySelector('.user')).toBe(node);expect(input.value).toBe('');
 const {readComposerDraft}=await import('../src/composerDrafts');
 await waitFor(async()=>expect((await readComposerDraft('m:followup'))?.text).toBe('Keep my follow-up'));
 await waitFor(()=>expect(input.readOnly).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Retry'}));
 await waitFor(()=>expect(sendMissionMessage).toHaveBeenCalledTimes(2));
 expect(vi.mocked(sendMissionMessage).mock.calls[1][3]).toBe(vi.mocked(sendMissionMessage).mock.calls[0][3]);
 expect(view.container.querySelector('.user')).toBe(node);
 expect(screen.getAllByText('Keep my follow-up')).toHaveLength(1);
});

it('shows a remote queued follow-up once and removes it without reopening the conversation',async()=>{
 const {getMission}=await import('../src/api');
 vi.mocked(getMission).mockResolvedValue({id:'remote-queued',status:'active',history:[],created_at:'',updated_at:''});
 let queued=true;
 vi.stubGlobal('fetch',vi.fn(async(url,options)=>{
  if(options?.method==='DELETE'){queued=false;return Response.json({ok:true});}
  if(String(url).includes('/queue?'))return Response.json(queued?[{id:'remote-message',mission_id:'remote-queued',content:'Durable remote follow-up',source:'remote-queue'}]:[]);
  return Response.json([],{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false','X-Max-Sequence':'0'}});
 }));
 render(()=><NativeMissionView id="remote-queued" initial={{id:'remote-queued',status:'active',history:[],created_at:'',updated_at:''}}/>);
 await waitFor(()=>expect(screen.getAllByText('Durable remote follow-up')).toHaveLength(1));
 const {fireEvent}=await import('@solidjs/testing-library');
 await fireEvent.click(screen.getByRole('button',{name:'Remove queued message: Durable remote follow-up'}));
 await waitFor(()=>expect(screen.queryByText('Durable remote follow-up')).toBeNull());
});

it('recovers a stored Antigravity answer on completion when live text was missed',async()=>{
 const polling=await import('../src/poll');
 let poll:undefined|(()=>void|Promise<unknown>);
 const pollSpy=vi.spyOn(polling,'pollWhileVisible').mockImplementation((run,ms)=>{if(ms===10000)poll=run;return ()=>{};});
 const id='antigravity-missed-final';
 const mission={id,backend:'antigravity',status:'active',history:[],created_at:'',updated_at:''};
 const {getMission}=await import('../src/api');
 vi.mocked(getMission).mockImplementation(async()=>({...mission}));
 let complete=false;
 vi.stubGlobal('fetch',vi.fn(async url=>{
  if(String(url).includes('/events'))return Response.json(complete?[{id:2,event_id:'agy-answer',sequence:2,event_type:'assistant_message',content:'I am Gemini inside Antigravity.',timestamp:''}]:[],{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false',...(complete?{'X-Next-Cursor':'2','X-Page-Max-Sequence':'2'}:{})}});
  return Response.json([]);
 }));
 const view=render(()=><NativeMissionView id={id} initial={mission} launch={{prompt:'What model are you?',nodeId:'core',destination:'Core'}}/>);
 await waitFor(()=>expect(state.event).toBeTypeOf('function'));
 await waitFor(()=>expect(view.container.querySelector('.agent-wait-status')).not.toBeNull());
 state.event!({type:'text_delta',data:{content:''}});
 expect(view.container.querySelector('.agent-wait-status')).not.toBeNull();
 state.event!({type:'thinking',data:{content:'Checking the requested model.',done:true}});
 state.event!({type:'tool_call',data:{tool_call_id:'partial-tool',name:'read',args:{}}});
 state.event!({type:'text_delta',data:{content:'I am'}});
 mission.status='awaiting_user';
 state.event!({type:'mission_status_changed',data:{status:'awaiting_user'}});
 await waitFor(()=>expect(view.container.querySelector('.agent-wait-status')).toBeNull());
 // Durable history lags the terminal status, and the live final never arrives.
 expect(screen.queryByText('I am Gemini inside Antigravity.')).toBeNull();
 complete=true;
 await poll!();
 await waitFor(()=>expect(screen.getByText('I am Gemini inside Antigravity.')).toBeDefined());
 expect(screen.queryByText('I am', {exact:true})).toBeNull();
 pollSpy.mockRestore();
 expect(view.container.querySelector('.agent-wait-status')).toBeNull();
});

it('replaces an edited remote queued message without leaving a duplicate Sending… row',async()=>{
 const {getMission,sendMissionMessage}=await import('../src/api');
 vi.mocked(getMission).mockResolvedValue({id:'edit-remote-queued',status:'active',history:[],created_at:'',updated_at:''});
 let rows=[{id:'orig-msg',mission_id:'edit-remote-queued',content:'Original queued text',source:'remote-queue'}];
 vi.mocked(sendMissionMessage).mockImplementation(async(_id,text,_attachments,clientMessageId)=>{
  const id=clientMessageId??'generated-id';
  rows=[...rows,{id,mission_id:'edit-remote-queued',content:text,source:'remote-queue'}];
  return {id,queued:true};
 });
 vi.stubGlobal('fetch',vi.fn(async(url,options)=>{
  const u=String(url);
  if(options?.method==='DELETE'){
   const deletedId=decodeURIComponent(u.split('/').pop()??'');
   rows=rows.filter(r=>r.id!==deletedId);
   return Response.json({ok:true});
  }
  if(u.includes('/queue?'))return Response.json(rows);
  return Response.json([],{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false','X-Max-Sequence':'0'}});
 }));
 const view=render(()=><NativeMissionView id="edit-remote-queued" initial={{id:'edit-remote-queued',status:'active',history:[],created_at:'',updated_at:''}}/>);
 await waitFor(()=>expect(view.container.querySelector('.scroll .col')).not.toBeNull());
 await waitFor(()=>expect(screen.getAllByText('Original queued text')).toHaveLength(1));
 const {fireEvent}=await import('@solidjs/testing-library');
 await fireEvent.click(screen.getByRole('button',{name:'Edit queued message: Original queued text'}));
 const input=screen.getByPlaceholderText('Send follow-up') as HTMLTextAreaElement;
 expect(input.value).toBe('Original queued text');
 fireEvent.input(input,{target:{value:'Edited queued text'}});
 fireEvent.keyDown(input,{key:'Enter'});
 await waitFor(()=>{
  expect(screen.getAllByText('Edited queued text')).toHaveLength(1);
  expect(screen.queryByText('Sending…')).toBeNull();
 });
 await waitFor(()=>expect(screen.queryByText('Original queued text')).toBeNull());
});

it('allows rapidly stacking multiple follow-up messages while earlier sends are still in flight',async()=>{
 const {getMission,sendMissionMessage}=await import('../src/api');
 vi.mocked(getMission).mockResolvedValue({id:'stack-busy',status:'active',history:[],created_at:'',updated_at:''});
 const resolvers:Array<(val:{id:string;queued:boolean})=>void>=[];
 const sentIds:string[]=[];
 vi.mocked(sendMissionMessage).mockImplementation((_id,_text,_attachments,clientMessageId)=>{
  const id=clientMessageId??'gen';
  sentIds.push(id);
  return new Promise(resolve=>{resolvers.push(()=>resolve({id,queued:true}));});
 });
 vi.stubGlobal('fetch',vi.fn(async(url)=>{
  if(String(url).includes('/queue?'))return Response.json([]);
  return Response.json([],{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false','X-Max-Sequence':'0'}});
 }));
 render(()=><NativeMissionView id="stack-busy" initial={{id:'stack-busy',status:'active',history:[],created_at:'',updated_at:''}}/>);
 const input=screen.getByPlaceholderText('Send follow-up') as HTMLTextAreaElement;
 const {fireEvent}=await import('@solidjs/testing-library');
 // Rapidly send 3 messages without waiting for the network
 for(const msg of ['First rapid message','Second rapid message','Third rapid message']){
  expect(input.readOnly).toBe(false);
  fireEvent.input(input,{target:{value:msg}});
  fireEvent.keyDown(input,{key:'Enter'});
  expect(input.value).toBe('');
 }
 // All 3 appear in the conversation before any network receipt.
 expect(screen.queryByRole('region',{name:'Queued messages'})).toBeNull();
 const texts=Array.from(document.querySelectorAll('.user')).map(el=>el.textContent);
 expect(texts).toEqual(['First rapid message','Second rapid message','Third rapid message']);
 // Drain serialized sends one by one
 await waitFor(()=>expect(resolvers).toHaveLength(1));
 resolvers[0]({id:sentIds[0],queued:true});
 await waitFor(()=>expect(resolvers).toHaveLength(2));
 resolvers[1]({id:sentIds[1],queued:true});
 await waitFor(()=>expect(resolvers).toHaveLength(3));
 resolvers[2]({id:sentIds[2],queued:true});
 await screen.findByText('3 Queued');
 await waitFor(()=>expect(screen.queryByText('Sending…')).toBeNull());
 const confirmedTexts=Array.from(document.querySelectorAll('.queue-text')).map(el=>el.textContent);
 expect(confirmedTexts).toEqual(['First rapid message','Second rapid message','Third rapid message']);
});

it('never leaks an in-flight Send now retry to another mission when the selected mission changes',async()=>{
 const {getMission,sendMissionMessage}=await import('../src/api');
 const [missionId,setMissionId]=createSignal('mission-origin');
 vi.mocked(getMission).mockImplementation(async(id)=>({
  id,
  status:id==='mission-origin'?'active':'completed',
  history:[],
  created_at:'',
  updated_at:'',
 }));
 const sentTargets:string[]=[];
 let finishSendNow!:(response:Response)=>void;
 const sendNowGate=new Promise<Response>(resolve=>{finishSendNow=resolve;});
 const cancelRequests:string[]=[];
 vi.mocked(sendMissionMessage).mockImplementation(async(id,_text,_attachments,clientMessageId)=>{
  sentTargets.push(id);
  return {id:clientMessageId??'msg',queued:true};
 });
 vi.stubGlobal('fetch',vi.fn(async(url,options)=>{
  const u=String(url);
  if(u.endsWith('/send-now')&&options?.method==='POST')return sendNowGate;
  if(u.endsWith('/cancel')&&options?.method==='POST'){
   cancelRequests.push(u);
   return Response.json({ok:true});
  }
  if(options?.method==='DELETE')return Response.json({ok:true});
  if(u.includes('/queue?'))return Response.json([{id:'q-1',mission_id:'mission-origin',content:'Do not leak this prompt',source:'remote-queue'}]);
  return Response.json([],{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false','X-Max-Sequence':'0'}});
 }));
 render(()=><NativeMissionView id={missionId()} initial={{id:missionId(),status:'active',history:[],created_at:'',updated_at:''}}/>);
 await screen.findByText('Do not leak this prompt');
 const {fireEvent}=await import('@solidjs/testing-library');
 await fireEvent.click(screen.getByRole('button',{name:'Send now: Do not leak this prompt'}));
 await waitFor(()=>expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/send-now'),expect.anything()));
 setMissionId('mission-unrelated');
 finishSendNow(Response.json({ok:true,delivered:false}));
 await new Promise(r=>setTimeout(r,50));
 expect(cancelRequests).toEqual([]);
 expect(sentTargets).not.toContain('mission-unrelated');
 expect(sentTargets).toEqual([]);
});




it('opens at the latest message despite initial layout scroll events, then respects manual scrolling', async () => {
 const {fireEvent}=await import('@solidjs/testing-library');
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json([])));
 const view=render(()=><NativeMissionView id="" launch={{messageKey:'scroll:open',prompt:'Latest message',nodeId:'core',destination:'Core'}}/>);
 const scroller=view.container.querySelector('.scroll') as HTMLElement;
 Object.defineProperties(scroller,{scrollHeight:{configurable:true,value:4000},clientHeight:{configurable:true,value:600}});
 fireEvent.scroll(scroller);
 await waitFor(()=>expect(scroller.scrollTo).toHaveBeenCalledWith({top:4000}));
 vi.mocked(scroller.scrollTo).mockClear();
 fireEvent.wheel(scroller,{deltaY:-200});fireEvent.scroll(scroller);
 await new Promise(resolve=>setTimeout(resolve,40));
 expect(scroller.scrollTo).not.toHaveBeenCalled();
});

it('first Enter displays the follow-up and steers in the background while the next draft survives',async()=>{
 const {getMission,sendMissionMessage,sendQueuedMessageNow}=await import('../src/api');
 vi.mocked(getMission).mockResolvedValue({id:'live-question',status:'active',history:[],created_at:'',updated_at:''});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json([],{headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false','X-Max-Sequence':'0'}})));
 vi.mocked(sendMissionMessage).mockImplementationOnce(async(_id,_text,_attachments,id)=>({id:id!,queued:true}));
 let delivered!:(value:boolean)=>void;
 vi.mocked(sendQueuedMessageNow).mockImplementationOnce(()=>new Promise(resolve=>{delivered=resolve;}));
 const view=render(()=><NativeMissionView id="live-question" initial={{id:'live-question',status:'active',history:[],created_at:'',updated_at:''}}/>);
 const input=screen.getByPlaceholderText('Send follow-up') as HTMLTextAreaElement;
 const {fireEvent}=await import('@solidjs/testing-library');
 fireEvent.input(input,{target:{value:'Continue checking the layout'}});fireEvent.keyDown(input,{key:'Enter'});
 expect(view.container.querySelector('.user')?.textContent).toContain('Continue checking the layout');
 expect(screen.queryByRole('region',{name:'Queued messages'})).toBeNull();
 await waitFor(()=>expect(delivered).toBeTypeOf('function'));
 fireEvent.input(input,{target:{value:'eta'}});
 expect(screen.getByText(/Sending to the running session/)).toBeTruthy();
 delivered(true);
 await waitFor(()=>expect(screen.getByText(/Sent to the running session/)).toBeTruthy());
 expect(input.value).toBe('eta');
 expect(view.container.querySelectorAll('.user').length).toBeGreaterThan(0);
 view.unmount();
});

it('empty Enter with no queued follow-up never resumes an idle chat',async()=>{
 const {getMission,sendMissionMessage,sendQueuedMessageNow}=await import('../src/api');
 vi.mocked(sendMissionMessage).mockClear();vi.mocked(sendQueuedMessageNow).mockClear();
 vi.mocked(getMission).mockResolvedValue({id:'empty-idle',status:'awaiting_user',history:[],created_at:'',updated_at:''});
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json([])));
 render(()=><NativeMissionView id="empty-idle" initial={{id:'empty-idle',status:'awaiting_user',history:[],created_at:'',updated_at:''}}/>);
 const {fireEvent}=await import('@solidjs/testing-library');
 fireEvent.keyDown(screen.getByPlaceholderText('Send follow-up'),{key:'Enter'});
 await Promise.resolve();expect(sendMissionMessage).not.toHaveBeenCalled();expect(sendQueuedMessageNow).not.toHaveBeenCalled();
});
