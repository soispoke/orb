import {createRoot,createComputed} from 'solid-js';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({store:new Map<string,unknown>(),active:true,missing:false,missionRead:vi.fn(),unavailable:"",paused:false,api:vi.fn(),effort:undefined as string|null|undefined,acknowledged:false,reopen:vi.fn(),launch:vi.fn(),follow:vi.fn(),save:vi.fn(),status:vi.fn(),append:vi.fn(),version:1,recover:vi.fn(),failure:vi.fn(),poll:vi.fn(),stopNative:vi.fn(),token:vi.fn(),steer:vi.fn()}));
vi.mock('../src/api',()=>({api:mocks.api,connectionVersion:()=>mocks.version,reopenMission:mocks.reopen,getMission:async(id:string)=>{mocks.missionRead(id);if(mocks.missing&&id==='mission')throw Object.assign(new Error('Mission not found'),{status:404});if(id===mocks.unavailable)throw Error('Unavailable mission');return {status:mocks.paused?'paused':mocks.acknowledged?'acknowledged':mocks.active?'active':'awaiting_user',tags:['placement:client'],model_effort:mocks.effort};},appendClientTranscript:mocks.append,setClientMissionStatus:mocks.status}));
vi.mock('../src/sideQuestionStorage',()=>({sideQuestionKey:()=>`account:${mocks.version}`}));
vi.mock('../src/composerDrafts',()=>({readSideThread:async(k:string)=>structuredClone(mocks.store.get(k)),saveSideThread:async(k:string,v:unknown)=>{mocks.save();mocks.store.set(k,structuredClone(v));}}));
vi.mock('../src/clientRuns',()=>({clientRunReceipt:async()=>({run_id:'r',generation:1})}));
vi.mock('../src/localAgents',()=>({localLiveText:()=>"Before steering",localActivities:()=>[],localInputToken:mocks.token,steerLocal:mocks.steer,recoverLocalLaunch:mocks.recover,recordLocalFailure:mocks.failure,restoreLocalBindings:async()=>{},localBinding:()=>({cwd:'/work',sessionId:'latest',planMode:false}),pollLocal:mocks.poll,reconcileLocalRun:async()=>{},startLocal:mocks.launch,followLocal:mocks.follow,stopLocal:mocks.stopNative}));
import {enqueueLocalMessage,localSteeringPending,queuedLocalMessages,startLocalQueueWorker,removeQueuedMessage,takeQueuedMessage,sendQueuedNow,wakeLocalQueue,retryQueuedMessage,resumedPrompt,holdQueuedMessage,releaseQueuedMessage,prioritizeQueuedMessage,cancelQueuedWakeups,captureWakeupFences,confirmWakeupStops,cutByConnection} from '../src/localMessageQueue';
const request={id:'mission',harness:'claudecode',bin:'claude',cwd:'/work',prompt:'first'};
let stop:(()=>void)|undefined;
beforeEach(()=>{mocks.missing=false;mocks.missionRead.mockReset();mocks.unavailable="";mocks.paused=false;mocks.api.mockReset().mockImplementation(async()=>{mocks.paused=false;});mocks.token.mockReset().mockResolvedValue('session-token');mocks.steer.mockReset().mockResolvedValue(undefined);mocks.effort=undefined;vi.useFakeTimers();mocks.poll.mockReset().mockImplementation(async()=>({done:!mocks.active}));mocks.stopNative.mockReset().mockImplementation(async()=>{mocks.active=false;});mocks.acknowledged=false;mocks.reopen.mockReset().mockResolvedValue(undefined);mocks.store.clear();mocks.recover.mockReset().mockResolvedValue(undefined);mocks.failure.mockReset();mocks.version=1;mocks.active=true;mocks.launch.mockReset().mockResolvedValue({run_id:'r',generation:1});mocks.follow.mockReset().mockResolvedValue({done:true,text:'Done',exit_code:0});mocks.save.mockReset();mocks.status.mockReset();mocks.append.mockReset().mockResolvedValue(undefined);Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_key:string,options:unknown,fn?: (lock:unknown)=>unknown)=>fn?fn({name:_key}):(options as ()=>unknown)()}});});
afterEach(()=>{stop?.();vi.useRealTimers();});
it('retains a Vibe plan command when a build-mode mission automatically resumes its interrupted followup',async()=>{
 mocks.active=false;
 mocks.follow.mockResolvedValueOnce({done:true,text:'Partial plan',exit_code:1,error:'ECONNRESET',retryable:true,resumed:true});
 const prompt='/plan Inspect the repository';
 stop=startLocalQueueWorker();
 await enqueueLocalMessage({...request,harness:'vibe',bin:'vibe-acp',prompt},prompt);
 await vi.advanceTimersByTimeAsync(100);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'queued',autoResumed:true,cut:'connection'});
 await vi.advanceTimersByTimeAsync(1000);
 const launches=mocks.launch.mock.calls.map(call=>call[0]);
 expect(launches).toHaveLength(2);
 expect(launches[0].prompt).toBe(prompt);
 expect(launches[1]).toMatchObject({harness:'vibe',sessionId:'latest'});
 // Native Vibe reads the command only at the start of the current prompt;
 // this mission's persisted binding is still in build mode.
 expect((await import('../src/localAgents')).localBinding('mission')?.planMode).toBe(false);
 expect(launches[1].prompt).toMatch(/^\/plan Inspect the repository\n\nThe connection was lost/);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('preserves goal commands during recovery without treating /planet as a mode',()=>{
 expect(resumedPrompt('  /goal Finish the audit')).toMatch(/^\/goal Finish the audit\n\nThe previous local run/);
 expect(resumedPrompt('/planet Inspect the repository')).toMatch(/^The previous local run/);
 expect(resumedPrompt('/planet Inspect the repository')).toMatch(/\n\n\/planet Inspect the repository$/);
});
it('persists active-run followups and drains them in order using the latest session',async()=>{
 await enqueueLocalMessage(request,'first');await enqueueLocalMessage({...request,prompt:'second'},'second');
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(1000);expect(mocks.launch).not.toHaveBeenCalled();
 mocks.active=false;window.dispatchEvent(new Event('orb:queue-wake'));await vi.advanceTimersByTimeAsync(2500);
 expect(mocks.launch.mock.calls.map(c=>c[0].prompt)).toEqual(['first','second']);expect(mocks.launch.mock.calls[0][0].sessionId).toBe('latest');expect(queuedLocalMessages('mission')).toEqual([]);
});
it('restores the queue after remount and steers without stopping or launching',async()=>{
 await enqueueLocalMessage(request,'first');await enqueueLocalMessage({...request,prompt:'second'},'second');
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(100);stop();
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(100);expect(queuedLocalMessages('mission')).toHaveLength(2);
 await removeQueuedMessage(queuedLocalMessages('mission')[1].id);await sendQueuedNow('mission');await vi.advanceTimersByTimeAsync(1100);
 expect(mocks.steer).toHaveBeenCalledTimes(1);expect(mocks.stopNative).not.toHaveBeenCalled();expect(mocks.recover).not.toHaveBeenCalled();expect(mocks.launch).not.toHaveBeenCalled();
});
it('does not silently replay an uncertain launch or let later messages overtake it',async()=>{
 mocks.active=false;mocks.launch.mockRejectedValue(new Error('connection lost'));
 await enqueueLocalMessage(request,'first');await enqueueLocalMessage({...request,prompt:'second'},'second');stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(4000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);expect(queuedLocalMessages('mission')[0].state).toBe('dispatching');expect(queuedLocalMessages('mission')[0].error).toMatch(/uncertain/);
});
it('keeps a draft unaccepted when durable storage fails',async()=>{
 mocks.save.mockImplementation(()=>{throw Error('disk full');});await expect(enqueueLocalMessage(request,'first')).rejects.toThrow('disk full');expect(mocks.launch).not.toHaveBeenCalled();
});
it('stops dispatching when the connection changes',async()=>{
 await enqueueLocalMessage(request,'first');stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(100);mocks.version=2;mocks.active=false;await vi.advanceTimersByTimeAsync(2000);expect(mocks.launch).not.toHaveBeenCalled();
});

it('wakes immediately for an idle mission without waiting for the polling interval',async()=>{
 mocks.active=false;stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(1);
 await enqueueLocalMessage(request,'immediate',{waiting:false});await vi.advanceTimersByTimeAsync(1);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
});
it('does not hold the queue lock while a launch is slow, and cannot cancel a claimed message',async()=>{
 mocks.active=false;let launch!:(value:unknown)=>void;
 mocks.launch.mockImplementation(()=>new Promise(resolve=>launch=resolve));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(1);
 await enqueueLocalMessage({...request,prompt:'second'},'second');
 const rows=queuedLocalMessages('mission');expect(rows).toHaveLength(2);
 await expect(removeQueuedMessage(rows[0].id)).rejects.toThrow('already been sent');
 await removeQueuedMessage(rows[1].id);expect(queuedLocalMessages('mission')).toHaveLength(1);
 launch({run_id:'r',generation:1});await vi.advanceTimersByTimeAsync(1);
});
it('keeps accepted messages durable across sync failure and never launches them twice',async()=>{
 mocks.active=false;mocks.append.mockRejectedValue(new Error('offline'));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(50);
 expect(queuedLocalMessages('mission')[0].state).toBe('accepted');
 expect(queuedLocalMessages('mission')[0].result?.text).toBe('Done');
 mocks.append.mockResolvedValue(undefined);window.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(1000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('saves a naturally completed answer before closing the receipt and releasing the next message',async()=>{
 mocks.active=false;let finish!:(value:unknown)=>void;
 mocks.follow.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(1);
 await enqueueLocalMessage({...request,prompt:'second'},'second');
 const stopping=sendQueuedNow('mission');await vi.advanceTimersByTimeAsync(1);
 finish({done:true,text:'Partial answer worth keeping',exit_code:0});await stopping;await vi.advanceTimersByTimeAsync(1);
 const partial=mocks.append.mock.calls.findIndex(c=>c[1]==='assistant'&&c[2]==='Partial answer worth keeping');
 expect(partial).toBeGreaterThanOrEqual(0);
 expect(mocks.append.mock.invocationCallOrder[partial]).toBeLessThan(mocks.status.mock.invocationCallOrder[0]);
 expect(mocks.status.mock.calls[0][1]).toBe('awaiting_user');
 expect(mocks.stopNative).not.toHaveBeenCalled();
 expect(mocks.launch).toHaveBeenCalledTimes(2);
});

it('requires confirmed recovery before retrying an uncertain native launch',async()=>{
 mocks.active=false;mocks.launch.mockRejectedValueOnce(new Error('another Orb window'));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(10);
 const id=queuedLocalMessages('mission')[0].id;
 mocks.recover.mockRejectedValueOnce(new Error('still running'));
 await expect(retryQueuedMessage(id)).rejects.toThrow('still running');
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 await retryQueuedMessage(id);await vi.advanceTimersByTimeAsync(10);
 expect(mocks.recover).toHaveBeenCalledWith('mission');expect(mocks.launch).toHaveBeenCalledTimes(2);
});
it('retains the real native failure even when the agent produced partial output',async()=>{
 mocks.active=false;mocks.follow.mockResolvedValue({done:true,text:'Partial',exit_code:0,error:'goal objective must be at most 4000 characters'});
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(10);
 expect(mocks.failure).toHaveBeenCalledWith('mission','goal objective must be at most 4000 characters');
 expect(mocks.status).toHaveBeenCalledWith('mission','failed',expect.anything(),undefined,'goal objective must be at most 4000 characters');
});

it('editing removes only a still-unsent message and rejects stale edits',async()=>{
 const id=await enqueueLocalMessage(request,'editable');
 expect(await takeQueuedMessage(id)).toBe('editable');
 expect(queuedLocalMessages('mission')).toHaveLength(0);
 await expect(takeQueuedMessage(id)).rejects.toThrow('no longer queued');
 const pending=await enqueueLocalMessage(request,'sending');
 for(const rows of mocks.store.values())if(Array.isArray(rows))for(const row of rows)if(row.id===pending)row.state='dispatching';
 await expect(takeQueuedMessage(pending)).rejects.toThrow('already been sent');
});

it('continues the session once after the app restarted under a running turn, then waits for the user',async()=>{
 mocks.active=false;
 const id=await enqueueLocalMessage(request,'resume');await enqueueLocalMessage({...request,prompt:'second'},'second');
 for(const rows of mocks.store.values())if(Array.isArray(rows))for(const row of rows)if(row.id===id){row.state='accepted';row.receipt={run_id:'previous',generation:1};}
 // The first follow finds no run (the app restarted); the resumed run is lost again.
 mocks.follow.mockRejectedValueOnce(new Error('no local run')).mockRejectedValueOnce(new Error('no local run'));
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(2000);
 expect(mocks.recover).toHaveBeenCalledWith('mission');
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(mocks.launch.mock.calls[0][0]).toMatchObject({prompt:resumedPrompt('first'),sessionId:'latest'});
 expect([...mocks.store.keys()].some(key=>key.includes(':recovered:')&&key.includes('previous'))).toBe(true);
 // Lost a second time: no loop, and the next message does not overtake it.
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'error',interrupted:true,autoResumed:true,error:expect.stringContaining('Your message is saved')});
 await vi.advanceTimersByTimeAsync(65000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 await retryQueuedMessage(id);await vi.advanceTimersByTimeAsync(100);
 expect(mocks.launch.mock.calls.map(call=>call[0].prompt)).toEqual([resumedPrompt('first'),resumedPrompt('first'),'second']);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('looks again for a queued message when the running turn belongs to another window',async()=>{
 await enqueueLocalMessage(request,'first');
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(1000);expect(mocks.launch).not.toHaveBeenCalled();
 mocks.active=false;await vi.advanceTimersByTimeAsync(31000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
});
it('keeps a missing accepted run fenced until recovery confirms it stopped, then continues it',async()=>{
 mocks.active=false;
 const id=await enqueueLocalMessage(request,'resume');
 for(const rows of mocks.store.values())if(Array.isArray(rows))for(const row of rows)if(row.id===id){row.state='accepted';row.receipt={run_id:'previous',generation:1};}
 mocks.follow.mockRejectedValueOnce(new Error('no local run'));
 mocks.recover.mockRejectedValue(new Error('agent still running'));
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(2000);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'accepted',interrupted:true});
 await expect(retryQueuedMessage(id)).rejects.toThrow('agent still running');
 await vi.advanceTimersByTimeAsync(65000);
 expect(mocks.launch).not.toHaveBeenCalled();
 // The previous agent has now stopped: the next periodic check continues the session.
 mocks.recover.mockResolvedValue(undefined);
 await vi.advanceTimersByTimeAsync(31000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(mocks.launch.mock.calls[0][0].prompt).toBe(resumedPrompt('first'));
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('makes a closed receipt recoverable without replaying it in the background',async()=>{
 mocks.active=false;mocks.append.mockRejectedValue(new Error('409 Local execution already ended or moved'));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(2500);
 const row=queuedLocalMessages('mission')[0];
 expect(row).toMatchObject({state:'error',interrupted:true,result:{text:'Done'}});
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 mocks.append.mockResolvedValue(undefined);
 await retryQueuedMessage(row.id);await vi.advanceTimersByTimeAsync(100);
 expect(mocks.recover).toHaveBeenCalledWith('mission');
 expect(mocks.launch).toHaveBeenCalledTimes(2);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('Send now recovers an already-ended run without trying to close a missing receipt',async()=>{
 mocks.active=false;mocks.status.mockRejectedValue(new Error('409 No active run on this computer'));
 await enqueueLocalMessage(request,'next');
 await expect(sendQueuedNow('mission')).resolves.toBe('queued');
 expect(mocks.recover).toHaveBeenCalledWith('mission');
 expect(mocks.status).not.toHaveBeenCalled();
});

it('removes an interrupted accepted send only after recovery and archives unsynced output',async()=>{
 const id=await enqueueLocalMessage(request,'saved');
 const rows=mocks.store.get('followups:account:1') as any[];
 Object.assign(rows[0],{state:'accepted',interrupted:true,error:'no local run',receipt:{run_id:'old',generation:1},result:{done:true,text:'Unsynced answer'}});
 mocks.recover.mockRejectedValueOnce(new Error('still running'));
 await expect(removeQueuedMessage(id)).rejects.toThrow('still running');
 expect(rows).toHaveLength(1);
 await removeQueuedMessage(id);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
 expect(mocks.store.get(`followups:account:1:recovered:${id}:old`)).toMatchObject({text:'saved',result:{text:'Unsynced answer'}});
 expect(mocks.launch).not.toHaveBeenCalled();
});
it('does not delete a newer attempt while recovery is pending',async()=>{
 const id=await enqueueLocalMessage(request,'saved');
 const rows=mocks.store.get('followups:account:1') as any[];
 Object.assign(rows[0],{state:'dispatching',error:'uncertain'});
 mocks.recover.mockImplementationOnce(async()=>{rows[0].state='accepted';delete rows[0].error;});
 await expect(removeQueuedMessage(id)).rejects.toThrow('changed while checking');
 expect((mocks.store.get('followups:account:1') as any[])[0]).toMatchObject({id,state:'accepted'});
});
it('does not report an unattached run as a mission failure',async()=>{
 const id=await enqueueLocalMessage(request,'saved');
 const rows=mocks.store.get('followups:account:1') as any[];
 Object.assign(rows[0],{state:'accepted',receipt:{run_id:'old',generation:1}});
 mocks.follow.mockRejectedValueOnce(new Error('no local run'));
 mocks.recover.mockRejectedValueOnce(new Error('another Orb window'));
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(1);
 expect(mocks.failure).toHaveBeenCalledWith('mission',null);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({interrupted:true,error:expect.stringContaining('another Orb window')});
});
// IndexedDB returns fresh object identities on every read. An unchanged poll
// must not rebuild the transcript, markdown, plan and token estimates.
it('does not invalidate conversation subscribers when idle polls are unchanged',async()=>{
 let renders=0,dispose!:()=>void;
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(1);
 createRoot(d=>{dispose=d;createComputed(()=>{queuedLocalMessages('mission');renders++;});});
 try {
  const initial=renders;await vi.advanceTimersByTimeAsync(5000);
  expect(renders).toBe(initial);
  await enqueueLocalMessage(request,'waiting');await vi.advanceTimersByTimeAsync(1);
  const changed=renders;expect(changed).toBeGreaterThan(initial);
  await vi.advanceTimersByTimeAsync(5000);expect(renders).toBe(changed);
  await removeQueuedMessage(queuedLocalMessages('mission')[0].id);
  expect(renders).toBeGreaterThan(changed);
 } finally {dispose();}
});

it('Send now recovers an absent native runner without calling stop',async()=>{
 await enqueueLocalMessage(request,'saved');
 mocks.poll.mockRejectedValue(new Error('no local run'));
 await sendQueuedNow('mission');
 expect(mocks.stopNative).not.toHaveBeenCalled();
 expect(mocks.recover).toHaveBeenCalledWith('mission');
 expect(mocks.launch).not.toHaveBeenCalled();
});
it('Send now does not treat a transport failure as proof that the runner stopped',async()=>{
 await enqueueLocalMessage(request,'saved');
 mocks.poll.mockRejectedValue(new Error('IPC disconnected'));
 await expect(sendQueuedNow('mission')).rejects.toThrow('IPC disconnected');
 expect(mocks.recover).not.toHaveBeenCalled();
 expect(mocks.stopNative).not.toHaveBeenCalled();
});
it('surfaces a persisted unconfirmed claim after restart without launching it again',async()=>{
 const id=await enqueueLocalMessage(request,'saved');
 for(const rows of mocks.store.values())if(Array.isArray(rows))for(const row of rows)if(row.id===id){row.state='dispatching';row.claimedAt=Date.now()-31000;}
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(100);
 expect(queuedLocalMessages('mission')[0].error).toMatch(/confirmation was lost/);
 expect(mocks.launch).not.toHaveBeenCalled();
});

it('edits a queued message in place while holding the queue, then sends in the new order',async()=>{
 await enqueueLocalMessage(request,'message 1');await enqueueLocalMessage({...request,prompt:'message 2'},'message 2');await enqueueLocalMessage({...request,prompt:'message 3'},'message 3');
 const [first,second,third]=queuedLocalMessages('mission');
 expect(await holdQueuedMessage(second.id)).toBe('message 2');
 stop=startLocalQueueWorker();mocks.active=false;window.dispatchEvent(new Event('orb:queue-wake'));await vi.advanceTimersByTimeAsync(2500);
 expect(mocks.launch).not.toHaveBeenCalled(); // the queue waits while a message is edited
 await enqueueLocalMessage({...request,prompt:'message 2 (edited)'},'message 2 (edited)',{id:second.id,replace:true});
 await prioritizeQueuedMessage(third.id);
 expect(queuedLocalMessages('mission').map(r=>r.text)).toEqual(['message 3','message 1','message 2 (edited)']);
 await vi.advanceTimersByTimeAsync(4000);
 expect(mocks.launch.mock.calls.map(c=>c[0].prompt)).toEqual(['message 3','first','message 2 (edited)']);
 expect(first.id).toBeTruthy();
});
it('refuses an edit once the message was sent, and a released hold no longer blocks the queue',async()=>{
 await enqueueLocalMessage(request,'only');const [row]=queuedLocalMessages('mission');
 await holdQueuedMessage(row.id);await releaseQueuedMessage(row.id);
 stop=startLocalQueueWorker();mocks.active=false;window.dispatchEvent(new Event('orb:queue-wake'));await vi.advanceTimersByTimeAsync(2500);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 await expect(enqueueLocalMessage(request,'too late',{id:row.id,replace:true})).rejects.toThrow('already sent');
});
it('an abandoned hold expires instead of blocking the queue forever',async()=>{
 await enqueueLocalMessage(request,'first');const [row]=queuedLocalMessages('mission');
 await holdQueuedMessage(row.id);
 stop=startLocalQueueWorker();mocks.active=false;
 window.dispatchEvent(new Event('orb:queue-wake'));await vi.advanceTimersByTimeAsync(2500);
 expect(mocks.launch).not.toHaveBeenCalled();
 vi.setSystemTime(Date.now()+16*60_000);
 window.dispatchEvent(new Event('orb:queue-wake'));await vi.advanceTimersByTimeAsync(2500);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
});
it('an in-place edit keeps images whose marker is still in the text',async()=>{
 const text='look [Image #1] [Uploaded: /work/.paloma/images/a.png]';
 await enqueueLocalMessage({...request,prompt:text,imagePaths:['/work/.paloma/images/a.png']},text);
 const [row]=queuedLocalMessages('mission');
 const edited='look closer [Image #1] [Uploaded: /work/.paloma/images/a.png]';
 await enqueueLocalMessage({...request,prompt:edited,imagePaths:[]},edited,{id:row.id,replace:true});
 expect(queuedLocalMessages('mission')[0].request.imagePaths).toEqual(['/work/.paloma/images/a.png']);
 await enqueueLocalMessage({...request,prompt:'no image',imagePaths:[]},'no image',{id:row.id,replace:true});
 expect(queuedLocalMessages('mission')[0].request.imagePaths).toEqual([]);
});
it('continues a turn cut by the connection once Core accepts its result, without asking',async()=>{
 mocks.active=false;
 mocks.follow.mockResolvedValueOnce({text:'Working on it.\n\nAPI Error: Can\'t reach the API server — check your internet or DNS (ENOTFOUND)',done:true,exit_code:0,resumed:true});
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await enqueueLocalMessage({...request,prompt:'second'},'second');await vi.advanceTimersByTimeAsync(3000);
 expect(mocks.status.mock.calls[0][1]).toBe('interrupted');
 expect(mocks.launch.mock.calls.map(call=>call[0].prompt)).toEqual(['first',resumedPrompt('first','connection'),'second']);
 expect(mocks.failure).not.toHaveBeenCalledWith('mission',expect.stringContaining('API Error'));
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('continues a cut turn after the computer was away and Core had closed its run',async()=>{
 mocks.active=false;
 mocks.follow.mockResolvedValueOnce({text:'API Error: Can\'t reach the API server — check your internet or DNS (ENOTFOUND)',done:true,exit_code:0,resumed:true});
 mocks.append.mockRejectedValueOnce(new Error('409 Local execution already ended or moved'));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await enqueueLocalMessage({...request,prompt:'second'},'second');await vi.advanceTimersByTimeAsync(3000);
 expect(mocks.launch.mock.calls.map(call=>call[0].prompt)).toEqual(['first',resumedPrompt('first','connection'),'second']);
 expect([...mocks.store.keys()].some(key=>key.includes(':recovered:'))).toBe(true);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('stops continuing by itself when the connection keeps cutting the turn',async()=>{
 mocks.active=false;
 mocks.follow.mockResolvedValue({text:'API Error: Connection error. (ECONNRESET)',done:true,exit_code:0,resumed:true});
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(65000);
 expect(mocks.launch).toHaveBeenCalledTimes(4);
 expect(mocks.status.mock.calls.at(-1)?.[1]).toBe('awaiting_user');
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('keeps a message queued while offline and sends it when the connection returns',async()=>{
 mocks.active=false;mocks.poll.mockRejectedValueOnce(new TypeError('Load failed'));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(100);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'queued',error:expect.stringContaining('connection')});
 expect(mocks.launch).not.toHaveBeenCalled();
 window.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(1000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('Send now retries the message that needs attention before the ones behind it',async()=>{
 mocks.active=false;mocks.append.mockRejectedValue(new Error('409 Local execution already ended or moved'));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await enqueueLocalMessage({...request,prompt:'second'},'second');await vi.advanceTimersByTimeAsync(2500);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'error',interrupted:true});
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 mocks.append.mockResolvedValue(undefined);
 await sendQueuedNow('mission');await vi.advanceTimersByTimeAsync(2500);
 expect(mocks.launch.mock.calls.map(call=>call[0].prompt)).toEqual(['first','first','second']);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it.each([false,true])('never interrupts old background work for a queued message (scheduled=%s)',async(scheduled)=>{
 mocks.poll.mockImplementation(async()=>({done:!mocks.active,waiting_since:mocks.active?Date.now()-24*60*60_000:null}));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first',{scheduled});await vi.advanceTimersByTimeAsync(31000);
 expect(mocks.stopNative).not.toHaveBeenCalled();expect(mocks.launch).not.toHaveBeenCalled();
 expect(queuedLocalMessages('mission')[0].state).toBe('queued');
 wakeLocalQueue();await vi.advanceTimersByTimeAsync(100);
 expect(mocks.stopNative).not.toHaveBeenCalled();expect(mocks.launch).not.toHaveBeenCalled();
 mocks.active=false;window.dispatchEvent(new Event('orb:queue-wake'));await vi.advanceTimersByTimeAsync(100);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
});
it('keeps a followed background run alive until it actually finishes',async()=>{
 mocks.active=false;let finish!:(value:unknown)=>void;
 mocks.follow.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(50);
 mocks.active=true;
 mocks.poll.mockImplementation(async()=>({done:!mocks.active,waiting_since:mocks.active?Date.now()-24*60*60_000:null}));
 await enqueueLocalMessage({...request,prompt:'second'},'second');await vi.advanceTimersByTimeAsync(31000);
 expect(mocks.stopNative).not.toHaveBeenCalled();
 expect(mocks.launch.mock.calls.map(call=>call[0].prompt)).toEqual(['first']);
 mocks.active=false;finish({text:'Finished',done:true,exit_code:0,resumed:true});await vi.advanceTimersByTimeAsync(100);
 expect(mocks.launch.mock.calls.map(call=>call[0].prompt)).toEqual(['first','second']);
});
it('sends again a message that failed only because nothing could be reached',async()=>{
 mocks.active=false;
 const id=await enqueueLocalMessage(request,'first');
 for(const rows of mocks.store.values())if(Array.isArray(rows))for(const row of rows)if(row.id===id){row.state='error';row.error='error sending request for url (https://core/api/control/missions/mission/client-run)';}
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(1000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('sends again, after checking the previous run, a launch that met a restarting Core',async()=>{
 mocks.active=false;mocks.launch.mockRejectedValueOnce(new Error('Could not inspect previous run (502 Bad Gateway): error code: 502'));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await enqueueLocalMessage({...request,prompt:'second'},'second');await vi.advanceTimersByTimeAsync(3000);
 expect(mocks.recover).toHaveBeenCalledWith('mission');
 expect(mocks.launch.mock.calls.map(call=>call[0].prompt)).toEqual(['first','first','second']);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('keeps an uncertain launch fenced while the previous agent cannot be confirmed stopped',async()=>{
 mocks.active=false;mocks.launch.mockRejectedValueOnce(new Error('503 Service Unavailable'));mocks.recover.mockRejectedValue(new Error('agent still running'));
 stop=startLocalQueueWorker();await enqueueLocalMessage(request,'first');await vi.advanceTimersByTimeAsync(65000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'dispatching',error:expect.stringContaining('uncertain')});
});

it('does not replay a delegated message after completion when its server acknowledgement was lost',async()=>{
 mocks.active=false;
 const id=crypto.randomUUID();
 stop=startLocalQueueWorker();
 await enqueueLocalMessage(request,'delegated',{id,delegated:true,waiting:false});
 await vi.advanceTimersByTimeAsync(1000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
 await enqueueLocalMessage(request,'delegated',{id,delegated:true,waiting:false});
 await vi.advanceTimersByTimeAsync(1000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});

it('keeps a busy-directory child queued and retries after the directory is released',async()=>{
 mocks.active=false;mocks.launch.mockRejectedValueOnce(new Error('Local launch deferred: directory busy'));
 await enqueueLocalMessage(request,'first',{delegated:true});
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(100);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'queued',error:expect.stringContaining('release this directory')});
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(31000);
 expect(mocks.launch).toHaveBeenCalledTimes(2);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});

it('steering preserves scheduled continuations and the original process',async()=>{
 const id=await enqueueLocalMessage({...request,prompt:'status'},'status');
 await enqueueLocalMessage({...request,prompt:'scheduled continuation'},'scheduled continuation',{scheduled:true,delegated:true});
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(100);
 await sendQueuedNow('mission',id);await vi.advanceTimersByTimeAsync(1500);
 expect(mocks.steer).toHaveBeenCalledWith('mission','session-token',id,'status');
 expect(mocks.stopNative).not.toHaveBeenCalled();expect(mocks.launch).not.toHaveBeenCalled();
 expect(queuedLocalMessages('mission')).toMatchObject([{text:'scheduled continuation',scheduled:true}]);
});

it.each(['claudecode','codex','grok','opencode','antigravity','vibe'])('unsupported %s never falls back to stop/restart',async harness=>{
 mocks.token.mockRejectedValue(new Error('No adapter; remains queued'));
 const id=await enqueueLocalMessage({...request,harness},'eta');
 await expect(sendQueuedNow('mission',id)).rejects.toThrow('remains queued');
 expect(mocks.stopNative).not.toHaveBeenCalled();expect(mocks.recover).not.toHaveBeenCalled();expect(mocks.launch).not.toHaveBeenCalled();
 expect(queuedLocalMessages('mission')[0]).toMatchObject({id,state:'queued'});
});

it('persists uncertain steering and never replays it after reopening',async()=>{
 const id=await enqueueLocalMessage(request,'status');
 mocks.steer.mockRejectedValue(new Error('IPC disconnected'));
 await expect(sendQueuedNow('mission',id)).rejects.toThrow('IPC disconnected');
 expect(localSteeringPending('mission',id)).toBe(false);
 mocks.active=false;stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(3000);
 await expect(retryQueuedMessage(id)).rejects.toThrow('cannot be replayed');
 expect(mocks.launch).not.toHaveBeenCalled();expect(mocks.recover).not.toHaveBeenCalled();
 expect(queuedLocalMessages('mission')[0]).toMatchObject({steerToken:'session-token',state:'error'});
});

it('fences a fetched wake-up across Stop, Core acknowledgement and replay',async()=>{
 const before=await captureWakeupFences();
 const token=await cancelQueuedWakeups('mission');
 const during=await captureWakeupFences();
 const stale=crypto.randomUUID();
 await enqueueLocalMessage(request,'old wake',{id:stale,delegated:true,scheduled:true,wakeupFence:before.mission});
 expect(queuedLocalMessages('mission')).toEqual([]);
 await confirmWakeupStops([{mission:'mission',token}]);
 await enqueueLocalMessage(request,'in-flight wake',{delegated:true,scheduled:true,wakeupFence:during.mission});
 expect(queuedLocalMessages('mission')).toEqual([]);
 const after=await captureWakeupFences();
 await enqueueLocalMessage(request,'replayed old wake',{id:stale,delegated:true,scheduled:true,wakeupFence:after.mission});
 expect(queuedLocalMessages('mission')).toEqual([]);
 await enqueueLocalMessage(request,'new wake',{delegated:true,scheduled:true,wakeupFence:after.mission});
 expect(queuedLocalMessages('mission').map(r=>r.text)).toEqual(['new wake']);
});
it('keeps a newer Stop fenced when an older cancellation acknowledgement arrives',async()=>{
 const older=await cancelQueuedWakeups('mission');
 await cancelQueuedWakeups('mission');
 await confirmWakeupStops([{mission:'mission',token:older}]);
 const fences=await captureWakeupFences();
 expect(fences.mission.blocked).toBe(true);
 await enqueueLocalMessage(request,'late',{delegated:true,scheduled:true,wakeupFence:fences.mission});
 expect(queuedLocalMessages('mission')).toEqual([]);
});
it('settles a scheduled local result using its occurrence identity',async()=>{
 mocks.active=false;
 const id=await enqueueLocalMessage(request,'wake',{scheduled:true});
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(2500);
 expect(mocks.status).toHaveBeenCalledWith('mission','awaiting_user',expect.anything(),id);
});
it('keeps a scheduled occurrence running across connection recovery and settles the final result',async()=>{
 mocks.active=false;
 mocks.follow.mockResolvedValueOnce({text:'API Error: Connection error. (ECONNRESET)',done:true,exit_code:1,resumed:true});
 const id=await enqueueLocalMessage(request,'wake',{scheduled:true});
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(3000);
 expect(mocks.launch).toHaveBeenCalledTimes(2);
 expect(mocks.status.mock.calls[0]).toEqual(['mission','interrupted',expect.anything()]);
 expect(mocks.status.mock.calls[1]).toEqual(['mission','awaiting_user',expect.anything(),id]);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});
it('settles a scheduled occurrence when connection retries are exhausted',async()=>{
 mocks.active=false;
 mocks.follow.mockResolvedValue({text:'API Error: Connection error. (ECONNRESET)',done:true,exit_code:1,resumed:true});
 const id=await enqueueLocalMessage(request,'wake',{scheduled:true});
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(65000);
 expect(mocks.launch).toHaveBeenCalledTimes(4);
 expect(mocks.status.mock.calls.slice(0,3).every(call=>call.length===3)).toBe(true);
 expect(mocks.status.mock.calls.at(-1)).toEqual(['mission','failed',expect.anything(),id,'Local process exited with code 1']);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});

it('Stop removes a dispatch claim while reopening and prevents a late native launch',async()=>{
 mocks.active=false;mocks.acknowledged=true;
 let release!:()=>void;mocks.reopen.mockImplementation(()=>new Promise<void>(resolve=>release=resolve));
 await enqueueLocalMessage(request,'wake',{scheduled:true,delegated:true});
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(100);
 expect(queuedLocalMessages('mission')[0].state).toBe('dispatching');
 await cancelQueuedWakeups('mission');release();await vi.advanceTimersByTimeAsync(100);
 expect(mocks.launch).not.toHaveBeenCalled();expect(queuedLocalMessages('mission')).toHaveLength(0);
});

it('recognizes Antigravity network and transient high-traffic errors and backs off before resuming',async()=>{
 expect(cutByConnection({text:'Partial',error:'There was a network issue connecting to the server, please try again. (response may be truncated)'})).toBe(true);
 expect(cutByConnection({text:'Partial',error:'Our servers are experiencing high traffic right now, please try again in a minute.'})).toBe(true);
 expect(cutByConnection({text:'Partial',error:'agent executor error: read tcp: read: no route to host'})).toBe(true);
 expect(cutByConnection({text:'Partial',error:'API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.'})).toBe(true);
 expect(cutByConnection({text:'Partial',error:'Unrecognized transient failure',retryable:true})).toBe(true);
 expect(cutByConnection({text:'Partial',error:'You have hit your usage limit · resets 9pm',retryable:true})).toBe(false);

 mocks.active=false;
 mocks.follow.mockResolvedValueOnce({
  text:'Step 1080 partial output',
  done:true,
  exit_code:1,
  error:'There was a network issue connecting to the server, please try again. (response may be truncated) (agent executor error: read: no route to host)',
  retryable:true,
  resumed:true,
 });
 stop=startLocalQueueWorker();
 await enqueueLocalMessage({...request,harness:'antigravity',bin:'agy'},'first');
 await vi.advanceTimersByTimeAsync(100);
 // First launch ran and was requeued with a 1s connection backoff; it does not relaunch at 100ms.
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(mocks.status).toHaveBeenCalledWith('mission','interrupted',expect.anything());
 expect(mocks.failure).toHaveBeenCalledWith('mission',null);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'queued',autoResumed:true,cut:'connection',resumes:1});
 await vi.advanceTimersByTimeAsync(1000);
 expect(mocks.launch).toHaveBeenCalledTimes(2);
 expect(mocks.launch.mock.calls[1][0].prompt).toBe(resumedPrompt('first','connection'));
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});

it('does not append duplicate identical assistant bubbles when an auto-resumed turn repeats its summary',async()=>{
 mocks.active=false;
 mocks.follow
  .mockResolvedValueOnce({
   text:'Tout est déjà terminé, signé et poussé.',
   done:true,
   exit_code:1,
   error:'There was a network issue connecting to the server, please try again.',
   retryable:true,
   resumed:true,
  })
  .mockResolvedValueOnce({
   text:'Tout est déjà terminé, signé et poussé.',
   done:true,
   exit_code:0,
   resumed:true,
  });
 stop=startLocalQueueWorker();
 await enqueueLocalMessage({...request,harness:'antigravity',bin:'agy'},'first');
 await vi.advanceTimersByTimeAsync(2500);
 expect(mocks.launch).toHaveBeenCalledTimes(2);
 const assistantAppends=mocks.append.mock.calls.filter(c=>c[1]==='assistant');
 expect(assistantAppends).toHaveLength(1);
 expect(assistantAppends[0][2]).toBe('Tout est déjà terminé, signé et poussé.');
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});

it('auto-resumes an Antigravity turn that ended while a background task was still running',async()=>{
 expect(cutByConnection({
  text:'I am verifying the Lean 4.31.0 reference proof for succinct-safe and will continue creating the three new task families once the check completes.',
  error:'Antigravity ended its headless turn while background task(s) ddd67091-4a2f-4fba-b905-7a8144dee4eb/task-2964 were still running; resume this conversation to inspect task logs or re-run foreground commands',
 })).toBe(true);

 mocks.active=false;
 mocks.follow.mockResolvedValueOnce({
  text:'I am verifying the Lean 4.31.0 reference proof for succinct-safe and will continue creating the three new task families once the check completes.',
  done:true,
  exit_code:1,
  error:'Antigravity ended its headless turn while background task(s) ddd67091-4a2f-4fba-b905-7a8144dee4eb/task-2964 were still running; resume this conversation to inspect task logs or re-run foreground commands',
  retryable:true,
  resumed:true,
 });
 stop=startLocalQueueWorker();
 await enqueueLocalMessage({...request,harness:'antigravity',bin:'agy'},'first');
 await vi.advanceTimersByTimeAsync(100);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(mocks.status).toHaveBeenCalledWith('mission','interrupted',expect.anything());
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'queued',autoResumed:true,cut:'background',resumes:1});
 await vi.advanceTimersByTimeAsync(1000);
 expect(mocks.launch).toHaveBeenCalledTimes(2);
 expect(mocks.launch.mock.calls[1][0].prompt).toBe(resumedPrompt('first','background'));
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});

it('requeues without flashing an error when a Send now launch briefly races an active non-terminal run on Core',async()=>{
 mocks.active=false;
 mocks.launch.mockRejectedValueOnce(new Error('Local launch rejected: 409: mission 123 already has non-terminal run abc generation 1'));
 stop=startLocalQueueWorker();
 await enqueueLocalMessage(request,'send-now-msg');
 await vi.advanceTimersByTimeAsync(50);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(queuedLocalMessages('mission')[0].state).toBe('queued');
 expect(queuedLocalMessages('mission')[0].error).toBeUndefined();
 await vi.advanceTimersByTimeAsync(500);
 expect(mocks.launch).toHaveBeenCalledTimes(2);
 expect(queuedLocalMessages('mission')).toHaveLength(0);
});



it.each(['high', null])('uses the current Antigravity effort at dispatch, including default (%s)',async(effort)=>{
 await enqueueLocalMessage({...request,harness:'antigravity',bin:'agy',model:'agy-demo',effort:'low'},'queued before settings change');
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(10);
 expect(mocks.launch).not.toHaveBeenCalled();
 mocks.effort=effort;mocks.active=false;
 window.dispatchEvent(new Event('orb:queue-wake'));await vi.advanceTimersByTimeAsync(10);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(mocks.launch.mock.calls[0][0]).toMatchObject({harness:'antigravity',model:'agy-demo',effort:effort??undefined,sessionId:'latest'});
});

it('persists the actual harness failure with the terminal status', async () => {
 mocks.active=false;
 const error='Unrecognized flag: --dir in command opencode run';
 mocks.follow.mockResolvedValueOnce({done:true,text:'',exit_code:1,error});
 stop=startLocalQueueWorker();
 await enqueueLocalMessage(request,'hello');
 await vi.advanceTimersByTimeAsync(1500);
 expect(mocks.status).toHaveBeenCalledWith('mission','failed',expect.anything(),undefined,error);
});


it('reports acceptance only after an acknowledged steer and transcript receipt',async()=>{
 const id=await enqueueLocalMessage(request,'status');
 await expect(sendQueuedNow('mission',id)).resolves.toBe('accepted');
 expect(mocks.steer).toHaveBeenCalledExactlyOnceWith('mission','session-token',id,'first');
 expect(mocks.append).toHaveBeenCalledWith('mission','user','status',id,{run_id:'r',generation:1});
});
it('does not turn an empty idle queue into a successful delivery receipt',async()=>{
 mocks.active=false;
 await expect(sendQueuedNow('mission')).resolves.toBe('unconfirmed');
 expect(mocks.recover).not.toHaveBeenCalled();expect(mocks.steer).not.toHaveBeenCalled();
});
it('does not report concurrent steering as accepted before the real acknowledgement',async()=>{
 const id=await enqueueLocalMessage(request,'status');
 let acknowledge!:()=>void;
 mocks.steer.mockImplementation(()=>new Promise<void>(resolve=>{acknowledge=resolve;}));
 const first=sendQueuedNow('mission',id);
 await vi.advanceTimersByTimeAsync(1);
 expect(localSteeringPending('mission',id)).toBe(true);
 expect(localSteeringPending('other-mission',id)).toBe(false);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({state:'error',steerToken:'session-token'});
 await expect(sendQueuedNow('mission',id)).resolves.toBe('unconfirmed');
 acknowledge();await expect(first).resolves.toBe('accepted');
 expect(localSteeringPending('mission',id)).toBe(false);
 expect(mocks.steer).toHaveBeenCalledTimes(1);
});
it('discards an old connection receipt without claiming delivery in the new view',async()=>{
 const id=await enqueueLocalMessage(request,'status');
 mocks.token.mockImplementation(async()=>{mocks.version=2;return 'old-token';});
 await expect(sendQueuedNow('mission',id)).resolves.toBe('unconfirmed');
 expect(mocks.steer).not.toHaveBeenCalled();expect(mocks.append).not.toHaveBeenCalled();
});

it('keeps a paused queue and interrupted recovery stopped across worker remounts',async()=>{
 mocks.active=false;
 const id=await enqueueLocalMessage(request,'saved question');
 mocks.paused=true;
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(4000);stop();
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(4000);
 expect(mocks.launch).not.toHaveBeenCalled();expect(queuedLocalMessages('mission')[0]).toMatchObject({id,state:'queued'});
 await sendQueuedNow('mission',id);await vi.advanceTimersByTimeAsync(100);
 expect(mocks.api).toHaveBeenCalledWith('/api/control/missions/mission/status',expect.objectContaining({body:JSON.stringify({status:'awaiting_user'})}));
 expect(mocks.launch).toHaveBeenCalledTimes(1);
});
it('a scheduled wake cannot release a pause but a new user message can',async()=>{
 mocks.active=false;mocks.paused=true;
 await enqueueLocalMessage(request,'wake',{scheduled:true,delegated:true});
 expect(mocks.api).not.toHaveBeenCalled();
 await enqueueLocalMessage({...request,prompt:'continue'},'continue');
 expect(mocks.api).toHaveBeenCalledTimes(1);
});

it('an unavailable historical mission cannot block another conversation queue',async()=>{
 mocks.active=false;
 await enqueueLocalMessage({...request,id:'old-mission'},'old question');
 await enqueueLocalMessage(request,'new question');
 mocks.unavailable='old-mission';
 stop=startLocalQueueWorker();await vi.advanceTimersByTimeAsync(1000);
 expect(mocks.launch).toHaveBeenCalledTimes(1);
 expect(mocks.launch.mock.calls[0][0].id).toBe('mission');
 expect(queuedLocalMessages('old-mission')).toHaveLength(1);
});

it('persists the transcript boundary before stdin and retains acceptance when sync fails',async()=>{
 await enqueueLocalMessage(request,'question');
 mocks.steer.mockImplementation(async()=>{
  const records=[...mocks.store.entries()].find(([key])=>key.startsWith('local-transcript:'))?.[1] as any[];
  expect(records).toEqual([expect.objectContaining({before:'Before steering',accepted:false,runId:'r'})]);
 });
 mocks.append.mockRejectedValueOnce(Error('offline'));
 await expect(sendQueuedNow('mission')).rejects.toThrow('offline');
 const records=[...mocks.store.entries()].find(([key])=>key.startsWith('local-transcript:'))?.[1] as any[];
 expect(records[0]).toMatchObject({accepted:true,text:'question'});
 expect(mocks.stopNative).not.toHaveBeenCalled();expect(mocks.launch).not.toHaveBeenCalled();
});

it('backs off missing missions without discarding input or blocking other chats',async()=>{
 await enqueueLocalMessage(request,'saved missing mission input');
 await enqueueLocalMessage({...request,id:'other'},'other chat');
 mocks.missing=true;mocks.missionRead.mockClear();
 stop=startLocalQueueWorker();
 await vi.advanceTimersByTimeAsync(59_000);
 const reads=(id:string)=>mocks.missionRead.mock.calls.filter(call=>call[0]===id).length;
 expect(reads('mission')).toBeLessThanOrEqual(4);
 expect(reads('other')).toBeGreaterThan(10);
 expect(queuedLocalMessages('mission')[0]).toMatchObject({text:'saved missing mission input',state:'queued'});
 expect(mocks.launch).not.toHaveBeenCalled();expect(mocks.stopNative).not.toHaveBeenCalled();expect(mocks.recover).not.toHaveBeenCalled();
 const before=reads('mission');mocks.missing=false;
 window.dispatchEvent(new Event('online'));await vi.advanceTimersByTimeAsync(1);
 expect(reads('mission')).toBeGreaterThan(before);
});
