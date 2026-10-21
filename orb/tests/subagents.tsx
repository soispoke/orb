import {render} from 'solid-js/web';
import {createSignal, onMount, onCleanup} from 'solid-js';
import {BackgroundPanel} from '../src/BackgroundPanel';
import {Subagents} from '../src/Subagents';
import type {StreamItem} from '../src/transcriptModel';
import '../src/styles.css';
const initial: StreamItem[] = [
  {kind:'subagent',key:'a',text:'Inspect the parser',agent:{id:'a',description:'Inspect the parser',status:'running',startedAt:Date.now()-63000,model:'Claude Opus',detail:'Reading token boundaries in parser.ts',prompt:'Check the parser for unicode boundary errors.'}},
  {kind:'subagent',key:'b',text:'Review the tests',agent:{id:'b',description:'Review the tests',status:'running',startedAt:Date.now()-120000,detail:'Running the focused test suite.'}},
  {kind:'subagent',key:'c',text:'Map the data flow',agent:{id:'c',description:'Map the data flow',status:'completed',startedAt:Date.now()-180000,finishedAt:Date.now()-30000,detail:'Mapped the request path. No gaps found.'}},
];
function ScrollGallery() {
 let scroller!: HTMLDivElement, content!: HTMLDivElement;
 let pinned=true;
 onMount(()=>{
  scroller.scrollTop=scroller.scrollHeight;
  const observer=new ResizeObserver(()=>{if(pinned)scroller.scrollTop=scroller.scrollHeight;});
  observer.observe(content); onCleanup(()=>observer.disconnect());
 });
 return <div ref={scroller} class="scroll" style={{height:'600px',flex:'none'}} onScroll={()=>{pinned=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80;}}>
  <div class="col" ref={content}>
   <div style={{height:'1200px'}}>Earlier conversation</div>
   <Subagents items={initial} onInspect={()=>{pinned=false;}}/>
  </div>
 </div>;
}
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
const workflow: StreamItem = {kind:'tool', key:'workflow', callId:'workflow', name:'Workflow', args:{}, done:true, result:'Transcript dir: /root/.claude/subagents/workflows/test'};
function SavedGallery() {
 const [local,setLocal]=createSignal<any[]>([]);
 return <BackgroundPanel tasks={<Subagents items={[]} local={local()} missionId="m"/>}>
 <button onClick={()=>setLocal([{id:'saved-call',tool_use_id:'saved-call',kind:'agent',background:true,label:'Resumed porter',done:false,status:'running'}])}>Receive live activity</button>
 </BackgroundPanel>;
}
render(()=> location.search.includes('saved') ? <SavedGallery/> : location.search.includes('workflow') ? <Subagents items={[workflow]} missionId="m" workspaceId="w"/> : location.search.includes('panel') ? <PanelGallery/> : location.search.includes('scroll') ? <ScrollGallery/> : <Gallery/>,document.getElementById('root')!);
