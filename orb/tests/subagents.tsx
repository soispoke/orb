import {render} from 'solid-js/web';
import {createSignal} from 'solid-js';
import {BackgroundPanel} from '../src/BackgroundPanel';
import {Subagents} from '../src/Subagents';
import type {StreamItem} from '../src/transcriptModel';
import '../src/styles.css';
const initial: StreamItem[] = [
  {kind:'subagent',key:'a',text:'Inspect the parser',agent:{id:'a',description:'Inspect the parser',status:'running',startedAt:Date.now()-63000,model:'Claude Opus',detail:'Reading token boundaries in parser.ts',prompt:'Check the parser for unicode boundary errors.'}},
  {kind:'subagent',key:'b',text:'Review the tests',agent:{id:'b',description:'Review the tests',status:'running',startedAt:Date.now()-120000,detail:'Running the focused test suite.'}},
  {kind:'subagent',key:'c',text:'Map the data flow',agent:{id:'c',description:'Map the data flow',status:'completed',startedAt:Date.now()-180000,finishedAt:Date.now()-30000,detail:'Mapped the request path. No gaps found.'}},
];
function Gallery() {
 const [items,setItems]=createSignal(initial);
 return <main style={{'max-width':'680px',margin:'80px auto',padding:'0 20px'}}>
   <h2 style={{'font-size':'18px','font-weight':'500'}}>Reviewing the implementation</h2>
   <p style={{color:'var(--fg-3)','font-size':'14px'}}>I’m checking the parser and tests in parallel.</p>
   <Subagents items={items()}/>
   <button onClick={()=>setItems(rows=>rows.map(row=>row.kind==='subagent'&&row.agent.id==='a'?{...row,agent:{...row.agent,status:'completed',finishedAt:Date.now(),detail:'Checked unicode boundaries. All tests pass.'}}:row))}>Complete first agent</button>
 </main>;
}
function PanelGallery() {
 return <div style={{height:'100vh',display:'flex'}}><BackgroundPanel tasks={<Subagents items={initial}/>}>
 <div class="scroll"><div class="col"><div style={{height:'1800px'}}>Conversation stays in place</div></div></div>
 <div class="dock"><div class="col">Composer</div></div>
 </BackgroundPanel></div>;
}
render(()=> location.search.includes('panel') ? <PanelGallery/> : <Gallery/>,document.getElementById('root')!);
