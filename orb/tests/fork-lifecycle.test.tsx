import {fireEvent,render,screen,waitFor} from '@solidjs/testing-library';
import {createSignal} from 'solid-js';
import {afterEach,expect,it,vi} from 'vitest';
import {ForkMission} from '../src/ForkMission';
import * as api from '../src/api';
import * as speed from '../src/CodexSpeedPicker';

const source={id:'source',title:'Work',backend:'grok',status:'active',history:[],created_at:'',updated_at:''} as api.Mission;
const choices=[{backend:{id:'grok',name:'Grok'},models:[{value:'grok-model',label:'Grok model'}]},{backend:{id:'codex',name:'Codex'},models:[{value:'gpt-6-astra',label:'GPT model'}]}] as api.HarnessChoice[];
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
afterEach(()=>vi.restoreAllMocks());
it('does not reopen a chat after its fork menu has unmounted',async()=>{
 let finish!:(mission:api.Mission)=>void;
 const fork=vi.spyOn(api,'forkMission').mockImplementation(()=>new Promise(resolve=>finish=resolve));
 const opened=vi.fn();
 const ui=render(()=><ForkMission mission={source} choices={choices} destination="Core" onClose={()=>{}} onFork={opened}/>);
 fireEvent.click(screen.getByRole('menuitem',{name:'Grok',exact:true}));
 fireEvent.click(screen.getByRole('menuitem',{name:'Grok model'}));
 await waitFor(()=>expect(fork).toHaveBeenCalledOnce());
 ui.unmount();finish({...source,id:'fork'});await tick();
 expect(opened).not.toHaveBeenCalled();
});
it('does not dispatch a fork after leaving during speed validation',async()=>{
 let finish!:()=>void;
 const preflight=vi.spyOn(speed,'requireSpeedSupport').mockImplementation(()=>new Promise(resolve=>finish=resolve));
 const fork=vi.spyOn(api,'forkMission');
 const ui=render(()=><ForkMission mission={source} choices={choices} destination="Core" onClose={()=>{}} onFork={()=>{}}/>);
 fireEvent.click(screen.getByRole('menuitem',{name:'Codex'}));
 fireEvent.click(screen.getByRole('menuitem',{name:'GPT model'}));
 fireEvent.click(screen.getByRole('menuitem',{name:'High',exact:true}));
 await waitFor(()=>expect(preflight).toHaveBeenCalledOnce());
 ui.unmount();finish();await tick();
 expect(fork).not.toHaveBeenCalled();
});
it('does not apply an old result after navigating away and back to the same chat',async()=>{
 let finish!:(mission:api.Mission)=>void;
 vi.spyOn(api,'forkMission').mockImplementation(()=>new Promise(resolve=>finish=resolve));
 const [mission,setMission]=createSignal(source),opened=vi.fn();
 render(()=><ForkMission mission={mission()} choices={choices} destination="Core" onClose={()=>{}} onFork={opened}/>);
 fireEvent.click(screen.getByRole('menuitem',{name:'Grok',exact:true}));
 fireEvent.click(screen.getByRole('menuitem',{name:'Grok model'}));
 setMission({...source,id:'other'});setMission(source);
 expect((screen.getByRole('menuitem',{name:'Grok',exact:true}) as HTMLButtonElement).disabled).toBe(false);
 finish({...source,id:'stale-fork'});await tick();
 expect(opened).not.toHaveBeenCalled();
});
it('closes stale effort choices when hovering a model without effort support',()=>{
 const mixed=[{backend:{id:'opencode',name:'OpenCode'},models:[{value:'reasoning',label:'Reasoning model',efforts:['low','high']},{value:'plain',label:'Plain model',efforts:[]}]}] as api.HarnessChoice[];
 const fork=vi.spyOn(api,'forkMission');
 render(()=><ForkMission mission={source} choices={mixed} destination="Core" onClose={()=>{}} onFork={()=>{}}/>);
 fireEvent.click(screen.getByRole('menuitem',{name:'OpenCode'}));
 fireEvent.mouseEnter(screen.getByRole('menuitem',{name:'Reasoning model'}));
 expect(screen.getByRole('menu',{name:'Choose effort'})).toBeTruthy();
 fireEvent.mouseEnter(screen.getByRole('menuitem',{name:'Plain model'}));
 expect(screen.queryByRole('menu',{name:'Choose effort'})).toBeNull();
 expect(fork).not.toHaveBeenCalled();
});
