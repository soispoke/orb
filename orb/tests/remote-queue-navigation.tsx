import {createSignal} from 'solid-js';
import {render} from 'solid-js/web';
import {RemoteQueue} from '../src/RemoteQueue';
import '../src/styles.css';

const [mission,setMission]=createSignal('first');
const [receipts,setReceipts]=createSignal<string[]>([]);
render(()=><main style={{padding:'24px','max-width':'760px',margin:'0 auto'}}>
 <nav aria-label="Fixture chats">
  <button onClick={()=>setMission('first')}>First chat</button>
  <button onClick={()=>setMission('second')}>Second chat</button>
 </nav>
 <h1>{mission()} chat</h1>
 <RemoteQueue mission={mission()} onRows={()=>{}} onCancel={id=>setReceipts(previous=>[...previous,`${mission()}:${id}`])}/>
 <output aria-label="Delivery receipts">{receipts().join(', ')}</output>
</main>,document.getElementById('root')!);
