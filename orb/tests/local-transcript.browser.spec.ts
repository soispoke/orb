import {test,expect} from '@playwright/test';
test.use({browserName:'webkit'});
test('local cumulative output stays separated by delivered questions after reload',async({page})=>{
 await page.goto('/tests/transcript.html');
 await page.waitForFunction(()=>!!(window as any).transcriptHarness);
 const canonical=[
  {kind:'user',key:'user:initial',messageId:'initial',text:'Work on the proof'},
  {kind:'text',key:'text:run:1',text:'Build is running. Two agents are working. ETA is 30 minutes.',live:false},
  {kind:'user',key:'user:status',messageId:'status',text:'what is running?'},
  {kind:'user',key:'user:eta',messageId:'eta',text:'eta'},
 ];
 const boundaries=[
  {id:'status',runId:'run',text:'what is running?',before:'Build is running.',activityKeys:[],accepted:true},
  {id:'eta',runId:'run',text:'eta',before:'Build is running. Two agents are working.',activityKeys:[],accepted:true},
 ];
 const current={runId:'run',text:canonical[1].text,active:true,activities:[]};
 await page.evaluate(async({canonical,boundaries,current})=>(window as any).transcriptHarness.local(canonical,boundaries,current),{canonical,boundaries,current});
 await expect(page.locator('.st-text')).toHaveText(['Build is running.','Two agents are working.','ETA is 30 minutes.']);
 const question=page.getByText('eta',{exact:true}),answer=page.getByText('ETA is 30 minutes.',{exact:true});
 expect((await answer.boundingBox())!.y).toBeGreaterThan((await question.boundingBox())!.y);
 await page.reload();await page.waitForFunction(()=>!!(window as any).transcriptHarness);
 await page.evaluate(async({canonical,current})=>(window as any).transcriptHarness.local(canonical,[],current),{canonical,current});
 await expect(page.locator('.st-text')).toHaveText(['Build is running.','Two agents are working.','ETA is 30 minutes.']);
 expect((await answer.boundingBox())!.y).toBeGreaterThan((await question.boundingBox())!.y);
 await page.screenshot({path:'test-results/local-steer-order.png'});
});

test('repairs legacy cumulative history and keeps each repeated question before its answer on reopening',async({page})=>{
 await page.goto('/tests/transcript.html');await page.waitForFunction(()=>!!(window as any).transcriptHarness);
 const canonical=[
  {kind:'user',key:'user:initial',messageId:'initial',text:'Work on the proof'},
  {kind:'text',key:'text:run:1',text:'Working.\n\nTen minutes.\n\nFour agents.\n\nFive minutes.',live:false},
  {kind:'user',key:'user:q1',messageId:'q1',text:'eta'},
  {kind:'user',key:'user:q2',messageId:'q2',text:'what is running?'},
  {kind:'user',key:'user:q3',messageId:'q3',text:'eta'},
 ];
 const cuts=[{id:'q1',before:'Working.'},{id:'q2',before:'Working.\n\nTen minutes.'},{id:'q3',before:'Working.\n\nTen minutes.\n\nFour agents.'}];
 await page.evaluate(async({canonical,cuts})=>(window as any).transcriptHarness.recover(canonical,cuts),{canonical,cuts});
 const assertOrder=async()=>{
  await expect(page.locator('.st-text')).toHaveText(['Working.','Ten minutes.','Four agents.','Five minutes.']);
  const positions=await Promise.all([page.getByText('eta',{exact:true}).nth(0),page.getByText('Ten minutes.',{exact:true}),page.getByText('what is running?',{exact:true}),page.getByText('Four agents.',{exact:true}),page.getByText('eta',{exact:true}).nth(1),page.getByText('Five minutes.',{exact:true})].map(async locator=>(await locator.boundingBox())!.y));
  expect(positions).toEqual([...positions].sort((a,b)=>a-b));
 };
 await assertOrder();
 await page.reload();await page.waitForFunction(()=>!!(window as any).transcriptHarness);
 await page.evaluate(async(canonical)=>(window as any).transcriptHarness.local(canonical,[],{text:'',active:false,activities:[]}),canonical);
 await assertOrder();
 await page.screenshot({path:'test-results/recovered-steer-order.png'});
});

for (const mode of ['snapshot','delta','text_op']) {
 test(`shared ${mode} stream preserves steering order after reopening`,async({page})=>{
  const initial={type:'text_delta',data:{mode:'snapshot',content:'Checking the build.'}};
  const delivered={type:'user_message',data:{id:'question',content:'eta'}};
  const continuation=mode==='snapshot'?{type:'text_delta',data:{mode:'snapshot',content:'Checking the build. About ten minutes.'}}:
   mode==='delta'?{type:'text_delta',data:{mode:'delta',content:' About ten minutes.'}}:
   {type:'text_op',data:{ops:[{type:'insert',pos:19,text:' About ten minutes.'}]}};
  const events=[initial,{type:'tool_call',data:{tool_call_id:'build',name:'Bash',args:{}}},delivered,continuation,{type:'assistant_message',data:{content:'Checking the build. About ten minutes.'}}];
  await page.goto('/tests/transcript.html');await page.waitForFunction(()=>!!(window as any).transcriptHarness);
  await page.evaluate(events=>{const h=(window as any).transcriptHarness;h.reset([]);for(const event of events)h.apply(event);},events);
  const check=async()=>{
   await expect(page.locator('.st-text')).toHaveText(['Checking the build.','About ten minutes.']);
   expect((await page.getByText('About ten minutes.',{exact:true}).boundingBox())!.y).toBeGreaterThan((await page.getByText('eta',{exact:true}).boundingBox())!.y);
  };
  await check();
  await page.reload();await page.waitForFunction(()=>!!(window as any).transcriptHarness);
  await page.evaluate(events=>(window as any).transcriptHarness.reset(events),events);
  await check();
 });
}

test('an overnight reply survives completion, immediate follow-ups and reopening',async({page})=>{
 await page.goto('/tests/transcript.html');await page.waitForFunction(()=>!!(window as any).transcriptHarness);
 const user=(id:string,text:string)=>({kind:'user',key:`user:${id}`,messageId:id,text});
 const text=(run:string,value:string)=>({kind:'text',key:`text:${run}:1`,text:value,live:false});
 const prefix='The previous build finished.';
 const full=prefix+'\n\nThe overnight reply is complete. All verification results are saved.';
 const cuts=[{id:'eta',runId:'old',text:'eta',before:prefix,activityKeys:[],accepted:true}];
 const cached=[user('initial','Continue the work'),text('old',prefix),user('eta','eta')];
 const transition=async(canonical:any[],runId:string,value:string)=>page.evaluate(({canonical,cuts,runId,value})=>(window as any).transcriptHarness.transition(canonical,cuts,{runId,text:value,active:true,activities:[]}),{canonical,cuts,runId,value});
 await transition(cached,'old',full);
 await transition(cached,'old','');
 await expect(page.getByText('The overnight reply is complete. All verification results are saved.',{exact:true})).toBeVisible();
 const next=[...cached,user('next','what’s next?'),text('new','The next step is ready.')];
 await transition(next,'new','The next step is ready.');
 await expect(page.locator('.st-text')).toHaveText([prefix,'The overnight reply is complete. All verification results are saved.','The next step is ready.']);
 const answer=page.getByText('The overnight reply is complete. All verification results are saved.',{exact:true});
 expect((await answer.boundingBox())!.y).toBeLessThan((await page.getByText('what’s next?',{exact:true}).boundingBox())!.y);
 const durable=[user('initial','Continue the work'),text('old',full),user('eta','eta'),user('next','what’s next?'),text('new','The next step is ready.')];
 await page.evaluate(async({durable,cuts})=>(window as any).transcriptHarness.local(durable,cuts,{runId:'new',text:'The next step is ready.',active:false,activities:[]}),{durable,cuts});
 await page.reload();await page.waitForFunction(()=>!!(window as any).transcriptHarness);
 await page.evaluate(async(durable)=>(window as any).transcriptHarness.local(durable,[],{runId:'new',text:'The next step is ready.',active:false,activities:[]}),durable);
 await expect(page.locator('.st-text')).toHaveText([prefix,'The overnight reply is complete. All verification results are saved.','The next step is ready.']);
});
