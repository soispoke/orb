import {createSignal,Show} from 'solid-js';
import {render} from 'solid-js/web';
import {ForkMission} from '../src/ForkMission';
import {setConnection,type Mission,type HarnessChoice} from '../src/api';
import {LOCAL_HARNESSES} from '../src/localAgents';
import '../src/styles.css';

// Exercise the real frontend launcher against an isolated native IPC fixture.
// No installed agents, user workspaces or remote services are contacted.
const backend=new URLSearchParams(location.search).get('from')??'claudecode';
const source:Mission={id:'source',title:'Proof work',status:'active',backend,project:'fixture',history:[{role:'user',content:'Continue verifying the proof.'},{role:'assistant',content:'An audit is still running.'}],created_at:'',updated_at:'',tags:['placement:client'],local_sync_pending:true};
const calls:{command:string;args:any}[]=[];
const binding={harness:backend,bin:`/fixture/${backend}`,cwd:'/fixture/workspace',sessionId:'original-native-session'};
let revision=0;
const bindings:Record<string,unknown>={source:binding};
const host=window as any;
host.forkCalls=calls;
const invoke=async(command:string,args:any={})=>{
 calls.push({command,args});
 if(command==='local_bindings_subscribe'){args.onEvent.onmessage({revision,bindings});return 1;}
 if(command==='local_bindings_unsubscribe')return;
 if(command==='local_bindings_refresh')return {revision,bindings};
 if(command==='local_agents_scan')return LOCAL_HARNESSES.map(id=>({id,path:`/fixture/${id}`,installed:true}));
 if(command==='local_antigravity_models')return [];
 if(command==='local_agents_cyber_capabilities')return 2;
 if(command==='local_agents_poll')return {done:true,text:'',activities:[]};
 if(command==='local_origin_launch'){
  // The native origin wire accepts sidebar folder tags only. Server-managed
  // placement/fork tags must never be forwarded by a desktop draft.
  if(args.draft.tags.some((tag:string)=>!tag.startsWith('orb-folder:')))throw Error('Invalid local folder tags');
  if(!/^[0-9a-f-]{36}$/.test(args.draft.key))throw Error('Invalid draft identity');
  if(args.request.session_id!==null)throw Error('A fork must use a fresh native session');
  if(!args.draft.share_folder)throw Error('Source folder is already occupied');
  revision++;bindings.fork={harness:args.request.harness,bin:args.request.bin,cwd:args.request.cwd};
  return {...source,id:'fork',title:args.draft.title,backend:args.request.harness,model_override:args.request.model};
 }
 throw Error('Unexpected native command: '+command);
};
host.__TAURI_INTERNALS__={invoke};
host.__TAURI__={core:{invoke,Channel:class{onmessage=(_:unknown)=>{};}}};
setConnection(location.origin,'fixture');
const [open,setOpen]=createSignal(false),[result,setResult]=createSignal('');
const choices:HarnessChoice[]=LOCAL_HARNESSES.map(id=>({backend:{id,name:id},models:[{value:id==='codex'?'gpt-6-astra':`${id}-model`,label:`${id} model`,efforts:['low','medium','high']}]})) as HarnessChoice[];
render(()=><main style={{padding:'24px'}}>
 <h1>Fork {backend} work</h1>
 <button onClick={()=>setOpen(true)}>Fork conversation</button>
 <Show when={open()}><ForkMission mission={source} choices={choices} destination="This computer" onClose={()=>setOpen(false)} onFork={mission=>{setResult(mission.backend??'');setOpen(false);}}/></Show>
 <output aria-label="Fork result">{result()}</output>
</main>,document.getElementById('root')!);
