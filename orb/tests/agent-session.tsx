import {render} from 'solid-js/web';
import {createSignal} from 'solid-js';
import {Subagents} from '../src/Subagents';
import {Transcript} from '../src/Transcript';
import {buildTranscript} from '../src/transcriptModel';
import type {StreamEvent} from '../src/stream';
import '../src/styles.css';
const notice=`Background agent "Proof check" didn't finish before the previous session ended`;
const update=(status:string,detail?:string):StreamEvent=>({type:'subagent_update',data:{agent:{id:'a',description:'Proof check',status,detail}}});
const saved=buildTranscript([{type:'tool_call',data:{tool_call_id:'old',name:'Background task',args:{command:notice}}},{type:'tool_result',data:{tool_call_id:'old',result:{status:'failed',error:notice}}}]);
function Gallery(){
 const [events,setEvents]=createSignal([update('failed',notice)]);
 const append=(e:StreamEvent)=>setEvents(es=>[...es,e]);
 return <main style={{padding:'32px'}}><Subagents items={buildTranscript(events())}/>
 <button onClick={()=>append(update('running','Using Read'))}>Live progress</button>
 <button onClick={()=>append(update('failed',notice))}>Replay old notice</button>
 <button onClick={()=>append(update('failed','Build exited with code 1'))}>Real failure</button>
 <Transcript items={saved}/></main>;
}
render(()=><Gallery/>,document.getElementById('root')!);
