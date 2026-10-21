import {expect, test, webkit} from '@playwright/test';

const prompt = 'Resume the verification work. Preserve all ongoing audits and builds.';
const retry = prompt + '\n\nContinuity reconciliation: recovered the missing receipts; no commands were replayed.';
const events = [
  {type:'user_message',data:{id:'original',content:prompt,source:'host-queue:api:default'}},
  {type:'assistant_message',data:{success:false,content:'Codex native continuity: codex_continuity_unresolved_tools: previous tool outcome needs reconciliation; no command was replayed'}},
  {type:'mission_status_changed',data:{status:'blocked',summary:'Native Codex history requires reconciliation before resume'}},
  {type:'user_message',data:{id:'retry',content:retry,source:'host-queue:api:default'}},
  {type:'tool_call',data:{tool_call_id:'audit',name:'bash',args:{command:'run-audit'}}},
];

for (const engine of ['chromium','webkit'] as const) {
  test(`continuity retry appears once and keeps details through streaming in ${engine}`,async({page: chromiumPage,baseURL})=>{
    const browser = engine === 'webkit' ? await webkit.launch() : undefined;
    const page = browser ? await browser.newPage({baseURL,viewport:{width:1100,height:900}}) : chromiumPage;
    try {
      await page.goto('/tests/transcript.html');
      await page.waitForFunction(()=>!!(window as any).transcriptHarness);
      await page.evaluate(events=>(window as any).transcriptHarness.reset(events),events);
      await expect(page.locator('.user')).toHaveCount(1);
      await expect(page.locator('.user')).toHaveText(prompt);
      await expect(page.locator('.user')).toHaveCSS('font-size','13px');
      const summary = page.locator('.background-wake summary');
      const body = page.locator('.background-wake-body');
      await expect(summary).toHaveText('Retried after interruption');
      await expect(summary).toBeVisible();
      await expect(body).toBeHidden();
      await summary.focus();await page.keyboard.press('Enter');
      await expect(body).toBeVisible();await expect(body).toHaveText(retry);
      await page.evaluate(()=>(window as any).transcriptHarness.apply({type:'text_delta',data:{content:'The audit is still running.'}}));
      await expect(body).toBeVisible();
      await expect(page.getByText('The audit is still running.',{exact:true})).toBeVisible();
      await summary.click();
      await page.setViewportSize({width:390,height:844});
      await expect(summary).toBeVisible();await expect(body).toBeHidden();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:`test-results/continuity-retry-${engine}.png`});
    } finally {await browser?.close();}
  });
}
