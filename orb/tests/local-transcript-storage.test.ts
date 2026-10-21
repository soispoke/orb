import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({rows:[] as any[]}));
vi.mock('../src/composerDrafts',()=>({readSideThread:async()=>structuredClone(state.rows),saveSideThread:async(_key:string,rows:any[])=>{state.rows=structuredClone(rows);}}));
vi.mock('../src/sideQuestionStorage',()=>({sideQuestionKey:(mission:string)=>mission}));
import {mergeRecoveredTranscriptBoundaries,localTranscriptBoundaries} from '../src/localTranscriptStorage';
const cut=(id:string,before:string)=>({id,runId:'run',before,text:'eta',activityKeys:[],accepted:true});
beforeEach(()=>{state.rows=[];Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_key:string,work:()=>Promise<void>)=>work()}});});
it('merges older recovered cuts ahead of new deliveries, preserving live evidence',async()=>{
 state.rows=[{...cut('q3','Working. Answer.'),activityKeys:['tool']},cut('q2','Working.')];
 await mergeRecoveredTranscriptBoundaries('mission',[cut('q1','Working.'),cut('q2','wrong'),cut('q1','duplicate')],['q1','q2','q3']);
 expect(state.rows.map(row=>row.id)).toEqual(['q1','q2','q3']);
 expect(state.rows[1].before).toBe('Working.');
 expect(state.rows[2].activityKeys).toEqual(['tool']);
 expect(localTranscriptBoundaries('mission')).toEqual(state.rows);
});
it('keeps separate run identities and imports no duplicates on retry',async()=>{
 state.rows=[{...cut('old','Old'),runId:'old-run'}];
 await mergeRecoveredTranscriptBoundaries('mission',[cut('q','Now')],['old','q']);
 await mergeRecoveredTranscriptBoundaries('mission',[cut('q','Now')],['old','q']);
 expect(state.rows.map(row=>[row.id,row.runId])).toEqual([['old','old-run'],['q','run']]);
});
