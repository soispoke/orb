import {expect,it} from 'vitest';
import {transcriptActivityOrder} from '../src/transcriptActivityOrder';
import type {StreamItem} from '../src/transcriptModel';
it('keeps live commands below newer questions and replies without rewriting completed history',()=>{
 const items:StreamItem[]=[
  {kind:'user',key:'q',text:'start'},
  {kind:'tool',key:'bash',name:'Bash',args:{command:'build'},done:false},
  {kind:'text',key:'progress',text:'Building'},
  {kind:'user',key:'eta',text:'eta'},
  {kind:'text',key:'answer',text:'About ten minutes'},
 ];
 expect(transcriptActivityOrder(items).map(i=>i.key)).toEqual(['q','progress','eta','answer','bash']);
 expect(items.map(i=>i.key)).toEqual(['q','bash','progress','eta','answer']);
 const complete=items.map(i=>i.kind==='tool'?{...i,done:true}:i);
 expect(transcriptActivityOrder(complete)).toBe(complete);
});
it('keeps simultaneous live tool order stable across harness names',()=>{
 for(const name of ['Bash','exec_command','bash','run_shell_command']){
  const items:StreamItem[]=[{kind:'tool',key:'one',name,done:false},{kind:'text',key:'text',text:'Update'},{kind:'tool',key:'two',name,done:false}];
  expect(transcriptActivityOrder(items).map(i=>i.key)).toEqual(['text','one','two']);
 }
});
