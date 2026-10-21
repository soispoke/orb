import {expect,test,webkit} from '@playwright/test';

const harnesses = ['claudecode','codex','opencode','grok'];
const pairs = [...harnesses.flatMap(from => harnesses.filter(to => to !== from).map(to => [from,to])), ['vibe','antigravity'], ['antigravity','vibe']];
for(const engine of ['chromium','webkit'] as const)for(const [from,to] of pairs){
 test(`local fork ${from} to ${to} in ${engine}`,async({page:defaultPage,baseURL})=>{
  const browser=engine==='webkit'?await webkit.launch():undefined;
  const page=browser?await browser.newPage({baseURL}):defaultPage;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
   await page.route('**/api/**',route=>{
    if(new URL(route.request().url()).pathname==='/api/control/cyber-capabilities')return route.fulfill({json:{version:2}});
    throw Error('Unexpected server request: '+route.request().method()+' '+route.request().url());
   });
   await page.goto(`/tests/local-fork.html?from=${from}`);
   await page.getByRole('button',{name:'Fork conversation',exact:true}).click();
   await page.getByRole('menuitem',{name:to,exact:true}).click();
   await page.getByRole('menuitem',{name:`${to} model`,exact:true}).click();
   const effort=to==='grok'||to==='vibe'?undefined:'high';
   if(effort)await page.getByRole('menuitem',{name:'High',exact:true}).click();
   await expect(page.getByLabel('Fork result')).toHaveText(to);
   const calls=await page.evaluate(()=>(window as any).forkCalls);
   const launches=calls.filter((call:any)=>call.command==='local_origin_launch');
   expect(launches).toHaveLength(1);
   expect(launches[0].args).toMatchObject({request:{harness:to,cwd:'/fixture/workspace',session_id:null},draft:{project:'fixture',share_folder:true,fork_source_mission_id:'source'}});
   expect(launches[0].args.request.effort).toBe(effort);
   expect(launches[0].args.request.prompt).toContain('An audit is still running.');
   expect(calls.some((call:any)=>/stop|cancel|recover/.test(call.command))).toBe(false);
   expect(errors).toEqual([]);
  }finally{await browser?.close();}
 });
}
