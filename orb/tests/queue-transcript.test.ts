import {it, expect} from 'vitest';
import {buildTranscript, applyStreamEvent, removeQueuedMessages} from '../src/transcriptModel';
it('preserves live text, tool indices and delivery identity after queued removal', () => {
  let items=buildTranscript([
    {type:'user_message',data:{id:'q',content:'Queued',queued:true}},
    {type:'text_delta',data:{content:'Working',mode:'delta'}},
    {type:'tool_call',data:{id:'tool',name:'Bash',args:{}}},
  ]);
  items=removeQueuedMessages(items,new Set(['q']));
  items=applyStreamEvent(items,{type:'tool_result',data:{id:'tool',result:'OK'}});
  items=applyStreamEvent(items,{type:'text_delta',data:{content:' now',mode:'delta'}});
  expect(items.find(i=>i.kind==='text')).toMatchObject({text:'Working now'});
  expect(items.find(i=>i.kind==='tool')).toMatchObject({done:true});
  items=applyStreamEvent(items,{type:'user_message',data:{id:'q',content:'Queued',queued:false}});
  expect(items.filter(i=>i.kind==='user')).toHaveLength(1);
  expect(removeQueuedMessages(items,new Set(['q']))).toBe(items);
});
