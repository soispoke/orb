import {afterEach, expect, it, vi} from 'vitest';
import {frameResizeObserver} from '../src/frameResizeObserver';
afterEach(()=>vi.unstubAllGlobals());
it('coalesces resize notifications outside observer delivery and cancels on disposal',()=>{
 let notify!:ResizeObserverCallback, frame!:FrameRequestCallback;
 const disconnect=vi.fn(), cancel=vi.fn();
 vi.stubGlobal('ResizeObserver',class {constructor(cb:ResizeObserverCallback){notify=cb;} observe(){} disconnect=disconnect;});
 vi.stubGlobal('requestAnimationFrame',vi.fn(cb=>{frame=cb;return 1;}));
 vi.stubGlobal('cancelAnimationFrame',cancel);
 const callback=vi.fn(), observer=frameResizeObserver(callback), target=document.createElement('div');
 const entry={target} as ResizeObserverEntry;
 notify([entry],{} as ResizeObserver);notify([entry],{} as ResizeObserver);
 expect(callback).not.toHaveBeenCalled();
 expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
 frame(0);expect(callback).toHaveBeenCalledTimes(1);
 expect(callback.mock.calls[0][0]).toHaveLength(1);
 notify([entry],{} as ResizeObserver);observer.disconnect();frame(1);
 expect(callback).toHaveBeenCalledTimes(1);expect(disconnect).toHaveBeenCalled();expect(cancel).toHaveBeenCalled();
});
