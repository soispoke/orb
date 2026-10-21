import type {StreamItem} from './transcriptModel';

/** Ongoing commands belong at the live edge. Keep the source chronology intact:
 * once a result arrives, its row returns to its original place in history. */
export function transcriptActivityOrder(items:StreamItem[]):StreamItem[]{
 const running=items.filter(item=>item.kind==='tool'&&!item.done);
 if(!running.length)return items;
 const ids=new Set(running.map(item=>item.key));
 return [...items.filter(item=>!ids.has(item.key)),...running];
}
