import {render} from 'solid-js/web';
import {createSignal} from 'solid-js';
import {Subagents} from '../src/Subagents';
import type {StreamItem} from '../src/transcriptModel';
import '../src/styles.css';
const initial: StreamItem[] = [
  {kind:'subagent',key:'a',text:'Inspect the parser',agent:{id:'a',description:'Inspect the parser',status:'running',detail:'Reading token boundaries in parser.ts',prompt:'Check the parser for unicode boundary errors.'}},
  {kind:'subagent',key:'b',text:'Review the tests',agent:{id:'b',description:'Review the tests',status:'running',detail:'Running the focused test suite.'}},
  {kind:'subagent',key:'c',text:'Map the data flow',agent:{id:'c',description:'Map the data flow',status:'completed',detail:'Mapped the request path. No gaps found.'}},
];
function Gallery() {
 const [items,setItems]=createSignal(initial);
 return <main style={{'max-width':'680px',margin:'80px auto',padding:'0 20px'}}>
   <h2 style={{'font-size':'18px','font-weight':'500'}}>Reviewing the implementation</h2>
   <p style={{color:'var(--fg-3)','font-size':'14px'}}>I’m checking the parser and tests in parallel.</p>
   <Subagents items={items()}/>
   <button onClick={()=>setItems(rows=>rows.map(row=>row.kind==='subagent'&&row.agent.id==='a'?{...row,agent:{...row.agent,status:'completed',detail:'Checked unicode boundaries. All tests pass.'}}:row))}>Complete first agent</button>
 </main>;
}
render(()=> <Gallery/>,document.getElementById('root')!);
