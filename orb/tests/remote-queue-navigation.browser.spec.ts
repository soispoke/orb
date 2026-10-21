import {expect,test,webkit} from '@playwright/test';

for (const engine of ['chromium','webkit'] as const) {
 test(`late queue delivery cannot lock or overwrite another chat in ${engine}`,async({page:chromiumPage,baseURL})=>{
  const browser=engine==='webkit'?await webkit.launch():undefined;
  const page=browser?await browser.newPage({baseURL,viewport:{width:1100,height:900}}):chromiumPage;
  try {
   await page.addInitScript(()=>{localStorage.setItem('orb.apiUrl',location.origin);localStorage.setItem('orb.jwt','fixture');});
   let releaseFirst!:()=>void, releaseSecond!:()=>void;
   const firstDelivery=new Promise<void>(resolve=>releaseFirst=resolve),secondDelivery=new Promise<void>(resolve=>releaseSecond=resolve);
   const sent:string[]=[];
   await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname.endsWith('/send-now')){
     const id=url.pathname.includes('/first/')?'first':'second';sent.push(id);
     await (id==='first'?firstDelivery:secondDelivery);
     return route.fulfill({json:{ok:true,delivered:true}});
    }
    if(url.pathname==='/api/control/queue'){
     const id=url.searchParams.get('mission_id');
     return route.fulfill({json:[{id,mission_id:id,content:`${id} message`,source:'remote-queue'}]});
    }
    throw new Error('Unexpected request: '+request.method()+' '+url.pathname);
   });
   await page.goto('/tests/remote-queue-navigation.html');
   await page.getByRole('button',{name:'Send now: first message'}).click();
   await expect.poll(()=>sent).toEqual(['first']);
   await page.getByRole('button',{name:'Second chat',exact:true}).click();
   const second=page.getByRole('button',{name:'Send now: second message'});
   await expect(second).toBeEnabled();await second.click();
   await expect.poll(()=>sent).toEqual(['first','second']);
   const firstResponse=page.waitForResponse(response=>response.url().includes('/first/send-now'));
   releaseFirst();await (await firstResponse).finished();
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   // The old completion must not unlock the still-pending action in this chat.
   await expect(second).toBeDisabled();
   await expect(page.getByLabel('Delivery receipts')).toHaveText('');
   releaseSecond();
   await expect(page.getByLabel('Delivery receipts')).toHaveText('second:second');
   await expect(page.getByRole('region',{name:'Queued messages'})).toHaveCount(0);
   await page.getByRole('button',{name:'First chat',exact:true}).click();
   await expect(page.getByRole('button',{name:'Send now: first message'})).toBeEnabled();
   await page.setViewportSize({width:390,height:844});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:`test-results/remote-queue-navigation-${engine}.png`});
  } finally {await browser?.close();}
 });
}
