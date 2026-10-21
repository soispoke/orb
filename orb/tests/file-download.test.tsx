import {createSignal} from 'solid-js';
import {render,fireEvent,waitFor} from '@solidjs/testing-library';
import {it,expect,vi,afterEach} from 'vitest';
import {FilePanelProvider} from '../src/FilePanel';
import {fileScopeKey, createFileClient} from '../src/fileResources';
import {api, setConnection} from '../src/api';
vi.mock('../src/api',async original=>({
  ...(await original<typeof import('../src/api')>()),
  getProjectController:vi.fn(async()=>({settings:{}})),api:vi.fn(),
}));
afterEach(()=>vi.restoreAllMocks());
const saved=(project:string)=>sessionStorage.setItem(`orb.files:${fileScopeKey({project})}`,JSON.stringify({
  tabs:[{source:'workspace',path:'data.bin',name:'data.bin',kind:'file'}],active:'workspace:data.bin',expanded:['workspace:'],open:true,
}));
function fixture(download:(q:any)=>Promise<unknown>){
  vi.mocked(api).mockImplementation(async (_path,init)=>{
    const q=JSON.parse(String(init?.body));
    if(q.action==='roots')return {sources:[{id:'workspace',label:'Workspace',available:true}]} as any;
    if(q.action==='read')return {binary:true,size:4,truncated:false} as any;
    if(q.action==='download')return await download(q) as any;
    return {entries:[]} as any;
  });
}
it('does not send an old file request through a newly selected connection',async()=>{
  fixture(async()=>({bytes:[1,2,3,4],next:4,size:4}));
  setConnection('https://first.invalid','fixture');
  const client=createFileClient({project:'first'});
  await client.roots();
  setConnection('https://second.invalid','fixture');
  const before=vi.mocked(api).mock.calls.length;
  await expect(client.call('workspace',{action:'download',path:'data.bin',offset:0})).rejects.toThrow('Connection changed');
  await expect(client.roots()).rejects.toThrow('Connection changed');
  expect(vi.mocked(api).mock.calls.length).toBe(before);
});
it('keeps a multi-part download on its original chat and separates same-name progress',async()=>{
  let release!:(value:unknown)=>void;
  const chunks:string[]=[];
  fixture(async q=>{
    chunks.push(q.project);
    if(chunks.length===1)return new Promise(resolve=>{release=resolve;});
    return {bytes:[3,4],next:4,size:4};
  });
  saved('first');saved('second');
  const [project,setProject]=createSignal('first');
  const {getByRole}=render(()=><FilePanelProvider scope={{project:project()}}>Chat</FilePanelProvider>);
  await waitFor(()=>expect(getByRole('button',{name:'Download file',exact:true})).toBeTruthy());
  fireEvent.click(getByRole('button',{name:'Download file',exact:true}));
  await waitFor(()=>expect(release).toBeTypeOf('function'));
  setProject('second');
  await waitFor(()=>expect(getByRole('button',{name:'Download file',exact:true})).toBeTruthy());
  release({bytes:[1,2],next:2,size:4});
  await waitFor(()=>expect(chunks).toHaveLength(2));
  expect(chunks).toEqual(['first','first']);
});
it('does not save a truncated transfer as a successful download',async()=>{
  fixture(async q=>q.offset===0?{bytes:[1,2],next:2,size:4}:{bytes:[],next:2,size:4});
  saved('broken');
  const {getByRole,container}=render(()=><FilePanelProvider scope={{project:'broken'}}>Chat</FilePanelProvider>);
  const old=Object.getOwnPropertyDescriptor(URL,'createObjectURL');
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:test')});
  const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  try{
    await waitFor(()=>expect(getByRole('button',{name:'Download file',exact:true})).toBeTruthy());
    fireEvent.click(getByRole('button',{name:'Download file',exact:true}));
    await waitFor(()=>expect(container.textContent).toContain('Incomplete file download'));
    expect(click).not.toHaveBeenCalled();
  }finally{
    if(old)Object.defineProperty(URL,'createObjectURL',old);else delete (URL as any).createObjectURL;
  }
});
