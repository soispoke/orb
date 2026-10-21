import {expect, test, webkit} from '@playwright/test';

const resume = 'Your previous turn was interrupted before it finished. Check what is already done, then continue from there. Do not redo finished work.';
for (const engine of ['chromium', 'webkit'] as const) {
  test(`notice details retain expansion after scrolling away in ${engine}`, async ({page: chromium, baseURL}) => {
    const browser = engine === 'webkit' ? await webkit.launch() : undefined;
    const page = browser ? await browser.newPage({baseURL, viewport:{width:1100,height:900}}) : chromium;
    try {
      await page.goto('/tests/transcript.html');
      await page.waitForFunction(() => !!(window as any).transcriptHarness);
      await page.evaluate(resume => {
        const events:any[] = [
          {type:'user_message',data:{id:'notice-resume',content:resume}},
          {type:'user_message',data:{id:'notice-reminder',content:'Check the existing workers.',source:'scheduler'}},
          {type:'user_message',data:{id:'notice-background',source:'background-task',content:'Background task `job` (`check`) finished. (No captured output was available.)\n\nContinue from here.'}},
        ];
        for(let i=0;i<120;i++) events.push(
          {type:'user_message',data:{id:`later-${i}`,content:`Question ${i}`}},
          {type:'assistant_message',data:{id:`answer-${i}`,content:`Answer ${i}\n\n`+'Context. '.repeat(100)}},
        );
        (window as any).transcriptHarness.reset(events);
        document.getElementById('transcript')!.scrollTop=0;
      },resume);
      const details=page.locator('[data-turn-key^="user:notice-"] details');
      await expect(details).toHaveCount(3);
      for(const detail of await details.all()) {
        const summary=detail.locator('summary');
        await summary.focus(); await page.keyboard.press('Enter');
        await expect(detail).toHaveAttribute('open','');
      }
      await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur();
        const scroller=document.getElementById('transcript')!;
        // A real scroll gesture ends the disclosure's short anchor transaction.
        scroller.dispatchEvent(new WheelEvent('wheel', {deltaY: 900, bubbles: true}));
        scroller.scrollTop=scroller.scrollHeight;
      });
      await expect(details).toHaveCount(0);
      await page.evaluate(() => { document.getElementById('transcript')!.scrollTop=0; });
      await expect(details).toHaveCount(3);
      for(const detail of await details.all()) await expect(detail).toHaveAttribute('open','');
      // Distinct resume attempts remain distinct records, even with identical text.
      await page.evaluate(resume => (window as any).transcriptHarness.reset([
        {type:'user_message',data:{id:'attempt-1',content:resume}},
        {type:'user_message',data:{id:'attempt-2',content:resume}},
        {type:'user_message',data:{id:'attempt-3',content:resume}},
      ]),resume);
      await expect(page.locator('.background-wake')).toHaveCount(3);
      await expect(page.locator('.background-wake[open]')).toHaveCount(0);
    } finally { await browser?.close(); }
  });
}
