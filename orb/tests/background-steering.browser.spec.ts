import {expect,test} from '@playwright/test';

for (const delivered of [true,false]) for (const message of ["Check the next layout issue", "status?"]) {
 test(`${message} appears immediately; background delivery ${delivered?'succeeds':'falls back without stopping work'}`,async({page})=>{
  let admit!:()=>void,steer!:()=>void;
  const admission=new Promise<void>(resolve=>admit=resolve),delivery=new Promise<void>(resolve=>steer=resolve);
  const requests:string[]=[];let row:{id:string;content:string;source:string}|undefined;let deliveryCalls=0;
  const mission={id:'read-recovery',backend:'codex',status:'active',project:'default',history:[],created_at:'',updated_at:''};
  await page.route('**/api/**',async route=>{
   const request=route.request(),path=new URL(request.url()).pathname;
   if(request.method()!=='GET')requests.push(path);
   if(path==='/api/control/missions/read-recovery')return route.fulfill({json:mission});
   if(path==='/api/control/message'){
    const body=request.postDataJSON();await admission;
    row={id:body.client_message_id,content:body.content,source:'host-queue:api:u'};
    return route.fulfill({json:{id:row.id,queued:true,message_accepted:true}});
   }
   if(path.endsWith('/send-now')){
    deliveryCalls++;await delivery;if(delivered)row=undefined;
    return route.fulfill({json:{ok:true,delivered}});
   }
   if(path==='/api/control/queue')return route.fulfill({json:row?[row]:[]});
   if(path.endsWith('/events'))return route.fulfill({json:[],headers:{'X-Orb-Events-Protocol':'1','X-Has-More':'false','X-Max-Sequence':'0'}});
   if(path==='/api/projects')return route.fulfill({json:{projects:[{slug:'default',title:'Default'}]}});
   return route.fulfill({json:[]});
  });
  await page.goto('/tests/message-recovery.html?active');
  const input=page.getByPlaceholder('Send follow-up');
  await expect(page.getByTitle('Stop',{exact:true})).toBeVisible();
  await input.fill(message);await input.press('Enter');
  await expect(page.locator('.user')).toHaveText(message);
  await expect(page.getByRole('region',{name:'Queued messages'})).toHaveCount(0);
  await expect(input).toHaveValue('');await expect(input).toHaveCSS('font-size','13px');
  await input.fill('The next draft stays here');admit();
  await expect.poll(()=>deliveryCalls).toBe(1);
  await expect(page.locator('.user')).toHaveCount(1);
  await expect(page.getByRole('region',{name:'Queued messages'})).toHaveCount(0);
  steer();
  if(delivered){
   await expect(page.getByText('Sent to the running session. The agent reads it after its current step; work continues.',{exact:true})).toBeVisible();
   await expect(page.locator('.user')).toHaveCount(1);
  }else{
   await expect(page.getByRole('region',{name:'Queued messages'})).toContainText(message);
   await expect(page.getByText('Queued for the next turn. Work continues.',{exact:true})).toBeVisible();
  }
  await expect(input).toHaveValue('The next draft stays here');
  await expect(page.getByTitle('Stop',{exact:true})).toBeVisible();
  expect(requests).toHaveLength(2);expect(requests[0]).toBe('/api/control/message');expect(requests[1]).toMatch(/\/queue\/.+\/send-now$/);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
}
