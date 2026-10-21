import {test,expect} from '@playwright/test';
test.use({browserName:process.env.ORB_TEST_BROWSER==='chromium'?'chromium':'webkit'});
test('download stays with its source while another chat opens the same filename',async({page})=>{
  const chunks:string[]=[];
  let finishFirst!:()=>void;
  await page.addInitScript(()=>{
    for(const project of ['verity-pareto','other']) sessionStorage.setItem(`orb.files:${location.origin}:project:${project}:controller:`,JSON.stringify({
      tabs:[{source:'workspace',path:'data.bin',name:'data.bin',kind:'file'}],active:'workspace:data.bin',expanded:['workspace:'],open:true,
    }));
  });
  await page.route('**/api/**',async route=>{
    if(!route.request().url().endsWith('/file-resources'))return route.fulfill({json:{settings:{}}});
    const q=route.request().postDataJSON();
    if(q.action==='roots')return route.fulfill({json:{sources:[{id:'workspace',label:'Workspace',available:true}]}});
    if(q.action==='read')return route.fulfill({json:{binary:true,size:4,truncated:false}});
    if(q.action==='download'){
      chunks.push(q.project);
      if(q.offset===0)await new Promise<void>(resolve=>{finishFirst=resolve;});
      return route.fulfill({json:{bytes:q.project==='verity-pareto'?(q.offset===0?[1,2]:[3,4]):[9,9],next:q.offset+2,size:4}});
    }
    return route.fulfill({json:{entries:[],results:[]}});
  });
  await page.goto('/tests/file-panel.html');
  await page.getByRole('textbox',{name:'Draft'}).fill('Keep draft');
  const saved=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download file',exact:true}).click();
  await expect.poll(()=>typeof finishFirst).toBe('function');
  await page.evaluate(()=>(window as any).setFileProject('other'));
  await expect(page.getByRole('button',{name:'Download file',exact:true})).toBeVisible();
  finishFirst();
  const download=await saved;
  const stream=await download.createReadStream();
  const bytes:Buffer[]=[];
  for await(const chunk of stream)bytes.push(Buffer.from(chunk));
  expect([...Buffer.concat(bytes)]).toEqual([1,2,3,4]);
  expect(chunks).toEqual(['verity-pareto','verity-pareto']);
  await expect(page.getByRole('button',{name:'Download file',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Draft'})).toHaveValue('Keep draft');
});
