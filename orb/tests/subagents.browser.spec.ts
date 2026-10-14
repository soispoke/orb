import {test,expect} from '@playwright/test';
test('subagents stay stable, readable, and keyboard accessible as they finish',async({page},testInfo)=>{
 await page.goto('/tests/subagents.html');
 const row=page.getByRole('button',{name:/Inspect the parser/});
 await row.focus();await page.keyboard.press('Enter');
 await expect(row).toHaveAttribute('aria-expanded','true');
 const before=await row.boundingBox();
 await page.getByRole('button',{name:'Complete first agent'}).click();
 await expect(row).toHaveAttribute('aria-expanded','true');
 await expect(row).toContainText('Done');
 const after=await row.boundingBox();
 expect(after!.y).toBe(before!.y);
 await expect(page.getByText('Checked unicode boundaries. All tests pass.')).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('subagents-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 await page.emulateMedia({reducedMotion:'reduce'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const dot=page.locator('.subagent[data-state=running] .subagent-dot').first();
 expect(await dot.evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
 await page.screenshot({path:testInfo.outputPath('subagents-mobile.png')});
});

test('side panel preserves disclosures and leaves conversation scroll alone',async({page},testInfo)=>{
 await page.goto('/tests/subagents.html?panel');
 const scroll=page.locator('.background-conversation .scroll');
 await scroll.evaluate(el=>el.scrollTop=400);
 const row=page.getByRole('button',{name:/Inspect the parser/});
 await row.click();
 expect(await scroll.evaluate(el=>el.scrollTop)).toBe(400);
 await page.getByRole('button',{name:'Close background tasks'}).click();
 await expect(page.getByRole('complementary',{name:'Background tasks'})).toBeHidden();
 await page.getByRole('button',{name:/Background tasks/}).click();
 await expect(row).toHaveAttribute('aria-expanded','true');
 await expect(page.getByText('Reading token boundaries in parser.ts')).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('side-panel.png')});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expect(row).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('side-panel-mobile.png')});
});


test('historical workflows stay unconfirmed across polls and settle on a failure receipt without closing', async ({page}) => {
 let polls = 0;
 let failed = false;
 await page.addInitScript(() => localStorage.setItem('orb.apiUrl', location.origin));
 await page.route('**/api/fs/download?**', async route => {
  const path = new URL(route.request().url()).searchParams.get('path')!;
  if (!path.endsWith('journal.jsonl')) {
   await route.fulfill({body:JSON.stringify({type:'assistant',timestamp:'2026-10-14T18:00:00Z',message:{content:[{type:'text',text:'Last known work'}]}})});
   return;
  }
  polls++;
  const events = [{type:'started',agentId:'a',label:'Historical child'}, ...(failed ? [{type:'failed',agentId:'a'}] : [])];
  await route.fulfill({body:events.map(e=>JSON.stringify(e)).join('\n')});
 });
 await page.goto('/tests/subagents.html?workflow');
 const row = page.getByRole('button', {name:/Historical child/});
 await expect(row).toContainText('Status unconfirmed');
 await row.click();
 await expect(page.getByText('Last known work')).toBeVisible();
 expect(await page.locator('.subagent-dot').evaluate(el=>getComputedStyle(el).boxShadow)).toBe('none');
 await expect.poll(()=>polls, {timeout:6000}).toBeGreaterThan(1);
 await expect(row).toContainText('Status unconfirmed');
 await expect(row).toHaveAttribute('aria-expanded','true');
 failed = true;
 await expect(row).toContainText('Failed', {timeout:6000});
 await expect(row).toHaveAttribute('aria-expanded','true');
 await expect(page.getByText('The workflow recorded an agent failure.')).toBeVisible();
});
