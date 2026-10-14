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

test('expanded agents remain rendered inside the real conversation scroller',async({page})=>{
 await page.goto('/tests/subagents.html?scroll');
 const panel=page.locator('.subagents');
 const heading=page.getByRole('button',{name:/Subagents/});
 await heading.click(); await heading.click();
 const row=page.getByRole('button',{name:/Inspect the parser/});
 await row.click();
 await expect(row).toHaveAttribute('aria-expanded','true');
 expect(await panel.evaluate(el=>getComputedStyle(el).contentVisibility)).toBe('visible');
 const samples=await page.evaluate(async()=>{
  const el=document.querySelector('.subagents')!; const points:number[]=[];
  for(let i=0;i<30;i++){await new Promise(requestAnimationFrame);points.push(el.getBoundingClientRect().top);}
  return points;
 });
 expect(Math.max(...samples)-Math.min(...samples)).toBeLessThan(2);
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
