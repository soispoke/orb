import {expect, it} from 'vitest';
import {hasTurnActivity} from '../src/turnActivity';
import {buildTranscript} from '../src/transcriptModel';
import type {StreamEvent} from '../src/stream';

it('a queue receipt after output does not resurrect the waiting indicator', () => {
 const events: StreamEvent[] = [
  {type:'user_message',data:{id:'first',content:'Work'}},
  {type:'assistant_message',data:{content:'Working on it'}},
  {type:'user_message',data:{id:'followup',content:'A+B asap',receipt:true,queued:false}},
 ];
 expect(hasTurnActivity(buildTranscript(events))).toBe(true);
 // Actual delivery starts a fresh turn, even when the receipt was already shown.
 events.push({type:'user_message',data:{id:'followup',content:'A+B asap'}});
 expect(hasTurnActivity(buildTranscript(events))).toBe(false);
 events.push({type:'text_delta',data:{content:'Starting A+B'}});
 expect(hasTurnActivity(buildTranscript(events))).toBe(true);
});
it('initial receipts without output still wait', () => {
 expect(hasTurnActivity(buildTranscript([{type:'user_message',data:{id:'first',content:'Work',receipt:true}}]))).toBe(false);
});
