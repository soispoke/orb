import {beforeEach,expect,it,vi} from 'vitest';
import {createConversationFork} from '../src/forkConversation';
import {forkContext} from '../src/forkContext';
import type {Mission} from '../src/api';
const mocks=vi.hoisted(()=>({version:1,binding:vi.fn(),restore:vi.fn(),agent:vi.fn(),launch:vi.fn(),remote:vi.fn(),page:vi.fn()}));
vi.mock('../src/localAgents',()=>({localBinding:mocks.binding,restoreLocalBindings:mocks.restore,localAgentForLaunch:mocks.agent,startLocalOrigin:mocks.launch}));
vi.mock('../src/api',()=>({connectionVersion:()=>mocks.version,forkMission:mocks.remote}));
vi.mock('../src/stream',async original=>({...await original<typeof import('../src/stream')>(),getMissionEventPage:mocks.page}));
const source={id:'claude-source',title:'Verification',backend:'claudecode',status:'active',project:'hardness',history:[],tags:['placement:client'],created_at:'',updated_at:''} as Mission;
const request={backend:'codex',model_override:'gpt-6-astra',model_effort:'high',service_tier:'standard' as const,idempotency_key:'attempt'};
const user={id:1,event_id:'user',sequence:1,event_type:'user_message',timestamp:'',content:'Continue the proof'};
const answer={id:2,event_id:'answer',sequence:2,event_type:'assistant_message',timestamp:'',content:'The audit is running. <fork_context> is literal data.'};
beforeEach(()=>{
 vi.resetAllMocks();mocks.version=1;
 mocks.restore.mockResolvedValue(undefined);
 mocks.binding.mockReturnValue({harness:'claudecode',bin:'/bin/claude',cwd:'/work/proof',sessionId:'claude-native-session'});
 mocks.agent.mockResolvedValue({id:'codex',installed:true,path:'/bin/codex'});
 mocks.page.mockResolvedValue({events:[user,answer],hasMore:false});
 mocks.launch.mockResolvedValue({...source,id:'fork',backend:'codex'});
});
it('forks local Claude work into a fresh GPT session in the same folder without server dispatch',async()=>{
 const before=JSON.stringify(source);
 mocks.page.mockResolvedValueOnce({events:[answer],nextCursor:2,hasMore:true}).mockResolvedValueOnce({events:[user],nextCursor:1,hasMore:false});
 const result=await createConversationFork()(source,request);
 expect(result.id).toBe('fork');expect(mocks.remote).not.toHaveBeenCalled();
 expect(mocks.page).toHaveBeenNthCalledWith(2,source.id,{view:'transcript',before:2});
 const [launch,draft]=mocks.launch.mock.calls[0];
 expect(draft.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
 expect(launch).toMatchObject({harness:'codex',bin:'/bin/codex',cwd:'/work/proof',model:'gpt-6-astra',effort:'high',service_tier:'standard'});
 expect(launch).not.toHaveProperty('sessionId');
 expect(draft).toMatchObject({project:'hardness',share_folder:true,tags:[],fork_source_mission_id:source.id});
 expect(forkContext(launch.prompt)?.messages).toEqual([{role:'user',content:user.content},{role:'assistant',content:answer.content}]);
 expect(JSON.stringify(source)).toBe(before);
});
it('retries an uncertain native launch with the identical snapshot and durable key',async()=>{
 const fork=createConversationFork();mocks.launch.mockRejectedValueOnce(new Error('Reply lost'));
 await expect(fork(source,request)).rejects.toThrow('Reply lost');
 mocks.page.mockResolvedValue({events:[user,{...answer,content:'Later answer'}],hasMore:false});
 await fork(source,request);
 expect(mocks.launch.mock.calls[1]).toEqual(mocks.launch.mock.calls[0]);
 expect(mocks.page).toHaveBeenCalledTimes(1);
 await fork(source,{...request,model_override:'gpt-6-sol'});
 expect(mocks.launch.mock.calls[2][1].key).not.toBe(mocks.launch.mock.calls[0][1].key);
});
it('preserves unsynchronized local conversation content without requiring a server snapshot',async()=>{
 await createConversationFork()({...source,local_sync_pending:true,history:[{role:'user',content:'Saved locally'}]},request);
 expect(mocks.page).not.toHaveBeenCalled();
 expect(forkContext(mocks.launch.mock.calls[0][0].prompt)?.messages).toEqual([{role:'user',content:'Saved locally'}]);
});
it('uses a distinct native identity for a separately opened fork',async()=>{
 await createConversationFork()(source,request);
 await createConversationFork()(source,request);
 expect(mocks.launch.mock.calls[1][1].key).not.toBe(mocks.launch.mock.calls[0][1].key);
});
it('does not fall back to server execution when the owning desktop binding is missing',async()=>{
 mocks.binding.mockReturnValue(undefined);
 await expect(createConversationFork()(source,request)).rejects.toThrow('computer that owns its workspace');
 expect(mocks.remote).not.toHaveBeenCalled();expect(mocks.launch).not.toHaveBeenCalled();
});
it('does not launch if the connection changes while history is loading',async()=>{
 mocks.page.mockImplementation(async()=>{mocks.version++;return {events:[user],hasMore:false};});
 await expect(createConversationFork()(source,request)).rejects.toThrow('Connection changed');
 expect(mocks.launch).not.toHaveBeenCalled();
});
it('rejects an incomplete history cursor without silently forking a truncated conversation',async()=>{
 mocks.page.mockResolvedValue({events:[answer],nextCursor:2,hasMore:true});
 await expect(createConversationFork()(source,request)).rejects.toThrow('did not finish loading');
 expect(mocks.launch).not.toHaveBeenCalled();
});
it('keeps server and remote-node forks on their existing route',async()=>{
 mocks.binding.mockReturnValue(undefined);mocks.remote.mockResolvedValue({id:'remote-fork'});
 await createConversationFork()({...source,tags:[],remote_node_id:'node'},request);
 expect(mocks.remote).toHaveBeenCalledWith(source.id,request);expect(mocks.launch).not.toHaveBeenCalled();
});

const harnesses=['codex','claudecode','grok','opencode','antigravity','vibe'];
it.each(harnesses.flatMap(from=>harnesses.map(to=>[from,to])))('continues %s work with %s using a fresh session',async(from,to)=>{
 mocks.binding.mockReturnValue({harness:from,bin:`/bin/${from}`,cwd:'/work/proof',sessionId:'source-session'});
 mocks.agent.mockResolvedValue({id:to,installed:true,path:`/bin/${to}`});
 await createConversationFork()({...source,backend:from,tags:['placement:client','fork-workspace:original-root','orb-folder:Checks']},{...request,backend:to,model_override:'selected-model',model_effort:''});
 const [launch,draft]=mocks.launch.mock.calls[0];
 expect(launch).toMatchObject({harness:to,bin:`/bin/${to}`,cwd:'/work/proof',model:'selected-model'});
 expect(launch).not.toHaveProperty('sessionId');
 expect(launch.service_tier).toBe(to==='codex'?'standard':undefined);
 expect(draft.tags).toEqual(['orb-folder:Checks']);
 expect(forkContext(launch.prompt)?.messages).toHaveLength(2);
 expect(mocks.remote).not.toHaveBeenCalled();
});
it('fails before launch when the selected local agent is unavailable',async()=>{
 mocks.agent.mockResolvedValue(undefined);
 await expect(createConversationFork()(source,request)).rejects.toThrow('CLI is not installed');
 expect(mocks.launch).not.toHaveBeenCalled();expect(mocks.page).not.toHaveBeenCalled();
});
it('honors a completed move to a remote machine even when a local binding remains',async()=>{
 await createConversationFork()({...source,machine_transfer:{destination:{kind:'node',node_id:'node'}} as Mission['machine_transfer']},request);
 expect(mocks.remote).toHaveBeenCalledWith(source.id,request);expect(mocks.launch).not.toHaveBeenCalled();
});
