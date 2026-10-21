import {test, expect} from '@playwright/test';
test('typing in a long draft does not collapse the focused field or move the caret line', async ({page}) => {
 await page.goto('/tests/form-feedback.html?voice');
 const input=page.locator('.composer textarea');
 await input.fill(Array.from({length:24},(_,i)=>`Line ${i}: some draft text`).join('\n'));
 await input.evaluate((el:HTMLTextAreaElement)=>{
  el.focus();
  const position=el.value.indexOf('Line 12:')+8;
  el.setSelectionRange(position,position);
  el.scrollTop=160;
  (window as any).collapsedWhileTyping=false;
  const observer=new MutationObserver(records=>{
   if(records.some(record=>/height:\s*0px/.test(record.oldValue??'')) || el.style.height==='0px') (window as any).collapsedWhileTyping=true;
  });
  observer.observe(el,{attributes:true,attributeFilter:['style'],attributeOldValue:true});
 });
 const before=await input.evaluate(el=>({top:el.scrollTop,y:el.getBoundingClientRect().y}));
 await input.pressSequentially('edited ',{delay:40});
 const after=await input.evaluate(el=>({top:el.scrollTop,y:el.getBoundingClientRect().y}));
 expect(await page.evaluate(()=>(window as any).collapsedWhileTyping)).toBe(false);
 expect(Math.abs(after.y-before.y)).toBeLessThan(1);
 expect(Math.abs(after.top-before.top)).toBeLessThan(1);
 await expect(input).toHaveValue(/Line 12:edited /);
});
test('composer expands for a soft wrap and shrinks back to one row', async ({page}, testInfo) => {
 await page.goto('/tests/form-feedback.html?voice');
 const input=page.locator('.composer textarea');
 const plus=page.locator('.composer .plus');
 await expect(page.locator('.voice-slot')).toBeVisible();
 const field=await input.boundingBox();
 const button=await plus.boundingBox();
 expect(Math.abs(field!.y+field!.height/2-button!.y-button!.height/2)).toBeLessThan(4);
 await input.fill('A short reply with enough words to wrap softly over two lines without an explicit newline.');
 await expect(page.locator('.composer')).toHaveClass(/tall/);
 await input.fill('A longer reply that needs two lines even after the input expands to its full width. '.repeat(2));
 await expect.poll(() => input.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
 await page.screenshot({path:testInfo.outputPath('two-lines.png')});
 await input.fill('Short');
 await page.evaluate(()=>new Promise(requestAnimationFrame));
 expect((await input.boundingBox())!.height).toBeLessThanOrEqual(24);
 await input.fill('');
 await page.evaluate(()=>new Promise(requestAnimationFrame));
 expect((await input.boundingBox())!.height).toBeLessThanOrEqual(24);
 await page.screenshot({path:testInfo.outputPath('empty.png')});
});
