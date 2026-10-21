import {describe,it,expect} from 'vitest';
import {reconcileAgentActivity,sessionEndAgent,UNCONFIRMED_AGENT} from '../src/agentSessionStatus';
import {localActivitiesToStreamItems} from '../src/workModel';
import {activityState} from '../src/AgentActivity';
import {buildTranscript} from '../src/transcriptModel';
import type {LocalActivity} from '../src/localAgents';
import type {StreamEvent} from '../src/stream';
const notice = `Background agent "Proof check" didn't finish before the previous session ended`;
const activity:LocalActivity={id:'task:a',label:'Background task',background:true,kind:'command',done:true,failed:true,status:'failed',detail:notice,finished_at:123};
const event=(type:string,data:Record<string,unknown>):StreamEvent=>({type,data});
describe('Claude session loss is not a worker failure',()=>{
 it('repairs old saved activities consistently in cards and tool rows',()=>{
  expect(reconcileAgentActivity(activity)).toMatchObject({status:'unknown',failed:false,done:false,kind:'agent',label:'Proof check',finished_at:undefined});
  expect(activityState(activity,true)).toBe('Status unconfirmed');
  const [item]=localActivitiesToStreamItems([activity]);
  expect(item).toMatchObject({kind:'tool',unresolved:true,done:true,result:UNCONFIRMED_AGENT});
  expect(activity.failed).toBe(true); // Presentation must not rewrite saved evidence.
 });
 it('keeps real failures and rate limits unchanged',()=>{
  for(const detail of ['Build exited with code 1','API Error: Request rejected (429)',notice+': build failed']){
   const real={...activity,detail};expect(reconcileAgentActivity(real)).toBe(real);expect(sessionEndAgent(detail)).toBeUndefined();
  }
  expect(reconcileAgentActivity({...activity,background:false}).failed).toBe(true);
 });
 it('replays ambiguous subagent failures as unknown, then accepts matching live evidence',()=>{
  const update=(status:string,detail?:string,id='a')=>event('subagent_update',{agent:{id,description:'Proof check',status,detail}});
  const rows=buildTranscript([update('failed',notice),update('running'),update('failed',notice),update('failed',notice,'b')]);
  expect(rows[0]).toMatchObject({agent:{status:'running'}});expect(rows[1]).toMatchObject({agent:{status:'unknown'}});
  expect(buildTranscript([update('failed','Build failed'),update('running')])[0]).toMatchObject({agent:{status:'failed'}});
 });
 it('replays old synthetic failed tool cards without a failure or success badge',()=>{
  const rows=buildTranscript([event('tool_call',{tool_call_id:'a',name:'Background task',args:{command:notice}}),event('tool_result',{tool_call_id:'a',result:{error:notice,status:'failed'}})]);
  expect(rows[0]).toMatchObject({kind:'tool',unresolved:true,result:{status:'unknown',message:UNCONFIRMED_AGENT}});
  expect((rows[0] as any).result.error).toBeUndefined();
  const real=buildTranscript([event('tool_result',{tool_call_id:'a',name:'Bash',result:{error:notice,status:'failed'}})]);
  expect((real[0] as any).result.status).toBe('failed');
 });
});
