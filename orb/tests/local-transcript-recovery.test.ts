import {beforeEach,expect,it,vi} from 'vitest';
import type {StreamItem} from '../src/transcriptModel';
const state=vi.hoisted(()=>({invoke:vi.fn(),rows:[] as any[],merge:vi.fn()}));
vi.mock('../src/clientRuns',()=>({nativeInvoke:()=>state.invoke}));
vi.mock('../src/localTranscriptStorage',()=>({localTranscriptBoundaries:()=>state.rows,mergeRecoveredTranscriptBoundaries:state.merge}));
import {recoverLocalTranscript} from '../src/localTranscriptRecovery';
import {projectLocalTranscript} from '../src/localTranscript';
beforeEach(()=>{state.rows=[];state.invoke.mockReset();state.merge.mockReset();});
const history:StreamItem[]=[
 {kind:'user',key:'initial',messageId:'initial',text:'Work'},
 {kind:'text',key:'text:r:1',text:'Working.\n\nTen minutes.\n\nFour agents.\n\nFive minutes.',live:false},
 {kind:'user',key:'user:q1',messageId:'q1',text:'eta'},
 {kind:'user',key:'user:q2',messageId:'q2',text:'what is running?'},
 {kind:'user',key:'user:q3',messageId:'q3',text:'eta'},
];
it('recovers the reopened history with repeated eta questions by delivery identity',async()=>{
 state.invoke.mockResolvedValue([{id:'q1',before:'Working.'},{id:'q2',before:'Working.\n\nTen minutes.'},{id:'q3',before:'Working.\n\nTen minutes.\n\nFour agents.'}]);
 await recoverLocalTranscript('mission','r',history);
 expect(state.invoke).toHaveBeenCalledWith('local_transcript_recover',{mission:'mission',full:(history[1] as any).text,questions:[{id:'q1',text:'eta'},{id:'q2',text:'what is running?'},{id:'q3',text:'eta'}]});
 const cuts=state.merge.mock.calls[0][1];
 const result=projectLocalTranscript(history,cuts,{text:'',active:false,activities:[]});
 expect(result.filter(i=>i.kind==='text'||i.kind==='user').map(i=>i.text.trim())).toEqual(['Work','Working.','eta','Ten minutes.','what is running?','Four agents.','eta','Five minutes.']);
});
it('does not invoke native recovery once every question already has a boundary',async()=>{
 state.rows=[{id:'q1'},{id:'q2'},{id:'q3'}];
 await recoverLocalTranscript('mission','r',history);
 expect(state.invoke).not.toHaveBeenCalled();
});
it('rejects foreign IDs and prefixes that do not match the requested snapshot',async()=>{
 state.invoke.mockResolvedValue([{id:'foreign',before:''},{id:'q1',before:'Changed output'}]);
 await recoverLocalTranscript('mission','r',history);
 expect(state.merge).toHaveBeenCalledWith('mission',[],['initial','q1','q2','q3']);
});
it('never attempts recovery against another run or an empty snapshot',async()=>{
 await recoverLocalTranscript('mission','other',history);
 await recoverLocalTranscript('mission','r',[{kind:'text',key:'text:r:1',text:'',live:true},history[2]]);
 expect(state.invoke).not.toHaveBeenCalled();
});

it('recovers run-owned stored text independently of its display key',async()=>{
 const {buildTranscript}=await import('../src/transcriptModel');
 const canonical=buildTranscript([
  {type:'user_message',data:{id:'initial',content:'Work'}},
  {type:'assistant_message',eventId:'r',data:{content:'Working.\n\nDone.'}},
  {type:'user_message',data:{id:'steer',content:'Status?'}},
 ]);
 state.invoke.mockResolvedValue([{id:'steer',before:'Working.'}]);
 await recoverLocalTranscript('mission','r',canonical);
 expect(state.invoke).toHaveBeenCalledWith('local_transcript_recover',{mission:'mission',full:'Working.\n\nDone.',questions:[{id:'steer',text:'Status?'}]});
 const result=projectLocalTranscript(canonical,state.merge.mock.calls[0][1],{runId:'r',text:'Working.\n\nDone.',active:false,activities:[]});
 expect(result.filter(i=>i.kind==='text'||i.kind==='user').map(i=>i.text.trim())).toEqual(['Work','Working.','Status?','Done.']);
});
