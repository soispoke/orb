import {test,expect} from '@playwright/test';
test('legacy stream corruption cannot repeat paragraphs or remove initial characters',async({page},info)=>{
 await page.goto('/tests/stream-recovery.html');
 const text='I prepared the coverage update.\n\nI am also validating the report.';
 await page.evaluate(text=>{
  const h=(window as any).recoveryHarness;
  h.snapshot(text,10);
  h.jobStatus();
  h.send('text_op',{bubble_id:'text_delta_latest',ops:[{type:'replace',range:[0,999],text:text+text.slice(1)+text}]});
 },text);
 await expect(page.locator('.st-text')).toHaveText('I prepared the coverage update.I am also validating the report.');
 await expect(page.getByText('I am also validating the report.',{exact:true})).toHaveCount(1);
 expect(await page.locator('.st-text .md').evaluate(el=>getComputedStyle(el).fontFamily)).not.toContain('Avenir');
 expect(await page.locator('.st-text .md').evaluate(el=>getComputedStyle(el).fontSize)).toBe('13px');
 await page.evaluate(()=>{
  const h=(window as any).recoveryHarness;
  h.send('tool_call',{tool_call_id:'build',name:'Bash',args:{command:'build'}});
  h.snapshot('I prepared the coverage update.\n\nI am also validating the report. All checks passed.',11);
  for(let i=0;i<100;i++)h.send('text_op',{bubble_id:'text_delta_latest',ops:[{type:'insert',pos:0,text:'corrupt'}]});
 });
 await expect(page.getByText('I am also validating the report. All checks passed.',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).recoveryHarness.reads())).toBeLessThan(8);
 await page.screenshot({path:info.outputPath('authoritative-live-text.png')});
 await page.evaluate(()=>{
  const h=(window as any).recoveryHarness;
  h.send('assistant_message',{id:'final',content:'Final answer.',success:true});
 });
 await expect(page.getByText('Final answer.',{exact:true})).toBeVisible();
 await expect(page.getByText(/I prepared the coverage/)).toHaveCount(0);
});

test('independently identified native text bubbles still stream without a history round trip',async({page})=>{
 await page.goto('/tests/stream-recovery.html');
 await page.evaluate(()=>{
  const h=(window as any).recoveryHarness;
  h.send('text_op',{bubble_id:'native:item:1',ops:[{type:'snapshot',revision:1,text:'Native response'}]});
 });
 await expect(page.getByText('Native response',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).recoveryHarness.reads())).toBe(0);
});

for(const harness of ['codex','antigravity','claude','grok','opencode']) {
 test(`${harness} retains replies before and after steering on replay`,async({page})=>{
  await page.goto('/tests/stream-recovery.html');
  const identified=['codex','antigravity'].includes(harness);
  const events:any[]=[{type:'user_message',data:{id:'start',content:'Continue work'}}];
  if(identified) {
   for(const [id,text] of [['a','Audit running.'],['b','Audit still running.']]) {
    if(id==='b')events.push({type:'user_message',data:{id:'eta',content:'eta'}});
    events.push({type:'assistant_message',data:{content:text,canonical:true,bubble_id:`${harness}:session:${id}`,revision:1}});
   }
  } else events.push(
   {type:'text_delta',sequence:2,data:{content:'Audit running.'}},
   {type:'user_message',data:{id:'eta',content:'eta'}},
   {type:'text_delta',sequence:4,data:{content:'Audit running.\n\nAudit still running.'}},
  );
  for(let pass=0;pass<2;pass++) {
   if(pass)await page.reload();
   await page.evaluate(events=>(window as any).recoveryHarness.replay(events),events);
   await expect(page.locator('.st-text')).toHaveCount(2);
   await expect(page.getByText('Audit running.',{exact:true})).toHaveCount(1);
   await expect(page.getByText('Audit still running.',{exact:true})).toHaveCount(1);
   const first=await page.getByText('Audit running.',{exact:true}).boundingBox();
   const question=await page.getByText('eta',{exact:true}).boundingBox();
   const second=await page.getByText('Audit still running.',{exact:true}).boundingBox();
   expect(first!.y).toBeLessThan(question!.y);expect(question!.y).toBeLessThan(second!.y);
  }
 });
}
