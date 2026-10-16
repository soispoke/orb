import {onCleanup} from 'solid-js';

/** Keep the trigger in place when details are inserted above it. */
export function anchoredDisclosure() {
 let frame=0, release=()=>{};
 const cancel=()=>{cancelAnimationFrame(frame);release();};
 onCleanup(cancel);
 return (trigger:HTMLElement, change:()=>void)=>{
  let scroller:HTMLElement|null=trigger.parentElement;
  while(scroller&&!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY))scroller=scroller.parentElement;
  const container=scroller??document.scrollingElement as HTMLElement;
  cancel();
  container?.dispatchEvent(new CustomEvent("orb:reader-scroll", {detail:{unpin:true}}));
  const before=trigger.getBoundingClientRect().top;
  change();
  // WebKit may reveal the focused toggle after the first layout frame.
  // Keep this short transaction anchored through that adjustment, but yield
  // immediately to a subsequent gesture instead of fighting the reader.
  const events=["wheel","touchstart","pointerdown","keydown"];
  for(const event of events)container?.addEventListener(event,cancel,{passive:true});
  release=()=>{for(const event of events)container?.removeEventListener(event,cancel);};
  let remaining=4;
  const restore=()=>{
   if(!trigger.isConnected||!container){release();return;}
   const delta=trigger.getBoundingClientRect().top-before;
   if(Math.abs(delta)>0.5)container.scrollTop+=delta;
   if(--remaining)frame=requestAnimationFrame(restore);else release();
  };
  frame=requestAnimationFrame(restore);
 };
}
