import {expect,it} from 'vitest';
import {isStatusQuestion} from '../src/statusQuestion';
it.each(['status?','Eta and status','TLDR of what it’s doing','how is it going?','what are you doing?','progress update please','what’s left?'])('recognizes a standalone progress question: %s',text=>expect(isStatusQuestion(text)).toBe(true));
it.each(['git status','status and fix the bugs','stop the build','resume the audit','what is the status of the implementation? then fix it','/plan status','/btw status','status\nkeep going','@status','implement a status panel','why did it stop?'])('keeps action or ambiguous requests on the normal path: %s',text=>expect(isStatusQuestion(text)).toBe(false));
