import {expect,it} from 'vitest';
import {createLocalTranscriptProjection,projectLocalTranscript,type LocalTranscriptBoundary} from '../src/localTranscript';
import type {StreamItem} from '../src/transcriptModel';
const text=(value:string,run='r'):StreamItem=>({kind:'text',key:`text:${run}:1`,text:value,live:false});
const user=(id:string):StreamItem=>({kind:'user',key:`user:${id}`,text:id,messageId:id});
const tool=(id:string):StreamItem=>({kind:'tool',key:id,callId:id,name:'Bash',args:{},done:false});
const cut=(id:string,before:string,activityKeys:string[]=[]):LocalTranscriptBoundary=>({id,runId:'r',text:id,before,activityKeys,accepted:true});
const live=(value:string,activities:StreamItem[]=[])=>({runId:'r',text:value,active:true,activities});
const visible=(items:StreamItem[])=>items.filter(i=>i.kind==='user'||i.kind==='text').map(i=>i.text);
it('splits cumulative local Claude output around steering instead of repeating it',()=>{
 const result=projectLocalTranscript([user('initial'),text('Working. Answer.'),user('status')],[cut('status','Working.')],live('Working. Answer.'));
 expect(visible(result)).toEqual(['initial','Working.','status',' Answer.']);
 expect(result.filter(i=>i.kind==='text').map(i=>i.live)).toEqual([false,true]);
});
it('keeps two questions between the text observed at each acceptance, including Unicode',()=>{
 const cuts=[cut('status','Build 🧪.'),cut('eta','Build 🧪. Running.')];
 const result=projectLocalTranscript([user('initial'),text('Build 🧪. Running. 10 minutes.'),user('status'),user('eta')],cuts,live('Build 🧪. Running. 10 minutes.'));
 expect(visible(result)).toEqual(['initial','Build 🧪.','status',' Running.','eta',' 10 minutes.']);
});
it('keeps accepted messages visible before history sync and after a serialized reload',()=>{
 const cuts=JSON.parse(JSON.stringify([cut('status','Working.')]));
 expect(visible(projectLocalTranscript([user('initial')],cuts,live('Working. Answer.')))).toEqual(['initial','Working.','status',' Answer.']);
 expect(visible(projectLocalTranscript([user('initial'),text('Working. Answer.'),user('status')],cuts,{text:'',active:false,activities:[]}))).toEqual(['initial','Working.','status',' Answer.']);
});
it('does not trim identical prose in an unrelated run or duplicate a cumulative snapshot',()=>{
 expect(visible(projectLocalTranscript([text('Same.','old'),user('next'),text('Same.')],[],live('Same.')))).toEqual(['Same.','next','Same.']);
});
it('leaves queued or unconfirmed questions unsent unless history confirms delivery',()=>{
 const boundary={...cut('eta','A.'),accepted:false};
 expect(visible(projectLocalTranscript([text('A.')],[boundary],live('A. B.')))).toEqual(['A. B.']);
 expect(visible(projectLocalTranscript([text('A. B.'),user('eta')],[boundary],live('A. B.')))).toEqual(['A.','eta',' B.']);
});
it('does not move old running tools below questions or duplicate them on refresh',()=>{
 const result=projectLocalTranscript([text('Before'),user('status')],[cut('status','Before',['old'])],live('BeforeAfter',[tool('old'),tool('new')]));
 expect(result.map(i=>i.key)).toEqual(['old','local:r:before:status','user:status','new','local:r']);
 expect(result.find(i=>i.key==='old')).toMatchObject({done:false});
});
it('handles empty and consecutive question boundaries without losing a reply',()=>{
 expect(visible(projectLocalTranscript([user('initial')],[cut('one',''),cut('two','')],live('Answer')))).toEqual(['initial','one','two','Answer']);
});
it('keeps corrected snapshot bytes and ignores an older live prefix',()=>{
 expect(visible(projectLocalTranscript([text('A. Longer')],[cut('q','A.')],live('A.')))).toEqual(['A.','q',' Longer']);
 expect(visible(projectLocalTranscript([text('A. old'),user('q')],[cut('q','A. old')],live('A. corrected')))).toEqual(['A. ','q','corrected']);
});
it('reconciles duplicate rows from one run by identity without changing other messages',()=>{
 expect(visible(projectLocalTranscript([text('Old'),user('q'),text('OldNew')],[cut('q','Old')],live('OldNew')))).toEqual(['Old','q','New']);
});
it('does not alter remote transcripts when no local run or boundaries are present',()=>{
 const items=[text('A'),user('q'),text('B','remote')];
 expect(projectLocalTranscript(items,[],{text:'',active:false,activities:[]})).toEqual(items);
});

it('retains the completed run when a follow-up clears native output before history catches up',()=>{
 const project=createLocalTranscriptProjection();
 const initial=[user('initial'),text('Working.'),user('eta')];
 const boundaries=[cut('eta','Working.')];
 expect(visible(project(initial,boundaries,live('Working. Full overnight answer.')))).toEqual(['initial','Working.','eta',' Full overnight answer.']);
 // startLocal clears output while the old receipt is still cached.
 expect(visible(project(initial,boundaries,live('')))).toContain(' Full overnight answer.');
 const next=[...initial,user('next'),text('Next answer','new')];
 expect(visible(project(next,boundaries,{runId:'new',text:'Next answer',active:true,activities:[]}))).toEqual(['initial','Working.','eta',' Full overnight answer.','next','Next answer']);
 const final=[user('initial'),text('Working. Full overnight answer.'),user('eta'),user('next'),text('Next answer','new')];
 expect(visible(project(final,boundaries,{runId:'new',text:'Next answer',active:false,activities:[]}))).toEqual(['initial','Working.','eta',' Full overnight answer.','next','Next answer']);
});
it('preserves an unmirrored completed answer before the next prompt without steering cuts',()=>{
 const project=createLocalTranscriptProjection();
 project([user('initial')],[],live('Saved locally.'));
 expect(visible(project([user('initial'),user('next')],[],{runId:'new',text:'Next answer',active:true,activities:[]}))).toEqual(['initial','Saved locally.','next','Next answer']);
});
it('keeps identical text in independent native runs and releases observed text after confirmation',()=>{
 const project=createLocalTranscriptProjection();
 project([user('first'),text('Same.')],[],live('Same.'));
 const next=[user('first'),text('Same.'),user('second'),text('Same.','new')];
 expect(visible(project(next,[],{runId:'new',text:'Same.',active:false,activities:[]}))).toEqual(['first','Same.','second','Same.']);
});

it('reconciles real stored events with local output after display keys are stabilized',async()=>{
 const {storedToStream}=await import('../src/stream');
 const {buildTranscript}=await import('../src/transcriptModel');
 const events=[
  {id:1,event_id:'question',sequence:1,event_type:'user_message',content:'Status?',timestamp:''},
  {id:2,event_id:'run',sequence:2,event_type:'assistant_message',content:'The result is saved.',timestamp:''},
 ].map(row=>storedToStream(row)!).filter(Boolean);
 const canonical=buildTranscript(events);
 const project=createLocalTranscriptProjection();
 expect(visible(project(canonical,[],{runId:'run',text:'The result is saved.',active:false,activities:[]}))).toEqual(['Status?','The result is saved.']);
 const next=buildTranscript([...events,{type:'user_message',data:{id:'next',content:'Again'}},{type:'assistant_message',eventId:'new',data:{content:'The result is saved.'}}]);
 expect(visible(project(next,[],{runId:'new',text:'The result is saved.',active:false,activities:[]}))).toEqual(['Status?','The result is saved.','Again','The result is saved.']);
});
