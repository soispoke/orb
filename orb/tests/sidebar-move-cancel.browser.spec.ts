import {test, expect} from '@playwright/test';
test.use({browserName: process.env.ORB_TEST_BROWSER === 'chromium' ? 'chromium' : 'webkit'});
for (const delayed of [false, true]) test(`Escape cancels a sidebar move from the composer${delayed ? ' before clipboard completion' : ''}`, async ({page}) => {
  await page.addInitScript(({delayed}) => {
    localStorage.setItem('orb.apiUrl',location.origin); localStorage.setItem('orb.jwt','test');
    let text = '';
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
      writeText: async (value: string) => {
        text=value;
        if(delayed) await new Promise<void>(resolve => Object.assign(window,{finishCut:resolve}));
      }, readText: async () => text,
    }});
  }, {delayed});
  const id='00000000-0000-0000-0000-000000000009';
  const mission={id,title:'Keep this agent',status:'awaiting_user',project:'one',tags:[],history:[],updated_at:'2026-10-19'};
  const writes: string[]=[];
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname;
    if(req.method()!=='GET') {writes.push(path);return route.fulfill({json:{ok:true}});}
    const json=path==='/api/projects'?{projects:[{slug:'one',title:'One'},{slug:'two',title:'Two'}]}
      :path==='/api/control/missions'?[mission]
      :path===`/api/control/missions/${id}`?mission
      :path.endsWith('/files')?{entries:[]}:path.endsWith('/crons')?{jobs:[]}:path.endsWith('/controller')?{job:null,runs:[]}:[];
    await route.fulfill({json});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'One',exact:true}).click();
  const row=page.getByRole('tree',{name:'Projects',exact:true}).getByRole('button',{name:'Keep this agent',exact:true}).first();
  await row.click();
  const composer=page.locator('textarea').first();
  await composer.fill('Preserve my draft');
  await row.click({button:'right'});
  await page.getByRole('menuitem',{name:'Move',exact:true}).click();
  if(delayed) await expect.poll(()=>page.evaluate(()=>typeof (window as any).finishCut)).toBe('function');
  else {
    await expect(row).toHaveClass(/mission-cut/);
    await row.click({button:'right'});
    await page.keyboard.press('Escape');
    await expect(row).toHaveClass(/mission-cut/);
  }
  await composer.focus();
  if (!delayed) {
    await composer.dispatchEvent('keydown', {key:'Escape',isComposing:true});
    await expect(row).toHaveClass(/mission-cut/);
  }
  await page.keyboard.press('Escape');
  if(delayed) {
    await page.getByRole('button',{name:'Two',exact:true}).focus();
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(150);
    expect(writes.filter(path=>path.endsWith('/project'))).toEqual([]);
    await page.evaluate(()=>(window as any).finishCut());
  }
  await expect(row).not.toHaveClass(/mission-cut/);
  await expect(composer).toHaveValue('Preserve my draft');
  await page.getByRole('button',{name:'Two',exact:true}).click({button:'right'});
  await expect(page.getByRole('menuitem',{name:'Move here',exact:true})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Two',exact:true}).focus();
  await page.keyboard.press('Meta+v');
  await page.waitForTimeout(150);
  expect(writes.filter(path=>path.endsWith('/project'))).toEqual([]);
});
