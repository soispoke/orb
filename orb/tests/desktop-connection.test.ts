import {afterEach,it,expect,vi} from 'vitest';
afterEach(()=>{delete (window as any).__TAURI__;localStorage.clear();vi.resetModules();});
it('restores the same desktop connection into an empty dev origin',async()=>{
 localStorage.clear();const invoke=vi.fn(async(command:string)=>command==='desktop_connection_load'?{api_url:'https://core.example',token:'fixture-token'}:undefined);
 (window as any).__TAURI__={core:{invoke}};
 const api=await import('../src/api');await api.restoreDesktopConnection();
 expect(api.getApiUrl()).toBe('https://core.example');expect(api.getJwt()).toBe('fixture-token');expect(api.isConnected()).toBe(true);
 api.clearConnection();await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('desktop_connection_save',{connection:null}));
});
it('preserves an explicit existing login rather than switching accounts on startup',async()=>{
 localStorage.setItem('orb.jwt','existing');localStorage.setItem('orb.apiUrl','https://other.example');
 const invoke=vi.fn(async()=>undefined);(window as any).__TAURI__={core:{invoke}};
 const api=await import('../src/api');await api.restoreDesktopConnection();
 expect(invoke).not.toHaveBeenCalledWith('desktop_connection_load');
 await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('desktop_connection_save',{connection:{api_url:'https://other.example',token:'existing'}}));
});
it('moves to a new address for the same server without signing in again',async()=>{
 localStorage.setItem('orb.jwt','existing');localStorage.setItem('orb.apiUrl','https://old.example');
 const invoke=vi.fn(async()=>undefined);(window as any).__TAURI__={core:{invoke}};
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('[]',{status:200}));
 const api=await import('../src/api');await api.moveConnection('http://127.0.0.1:13000/');
 expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:13000/api/backends');
 expect((fetch.mock.calls[0][1] as RequestInit).headers).toEqual({Authorization:'Bearer existing'});
 expect(invoke).toHaveBeenCalledWith('desktop_connection_move',{from:'https://old.example',to:'http://127.0.0.1:13000',token:'existing'});
 expect(api.getApiUrl()).toBe('http://127.0.0.1:13000');expect(api.getJwt()).toBe('existing');
 fetch.mockRestore();
});
it('keeps the current address when the new one rejects the sign-in',async()=>{
 localStorage.setItem('orb.jwt','existing');localStorage.setItem('orb.apiUrl','https://old.example');
 const invoke=vi.fn(async()=>undefined);(window as any).__TAURI__={core:{invoke}};
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:401}));
 const api=await import('../src/api');
 await expect(api.moveConnection('https://other.example')).rejects.toThrow(/isn’t the same server/);
 expect(invoke).not.toHaveBeenCalledWith('desktop_connection_move',expect.anything());
 expect(api.getApiUrl()).toBe('https://old.example');
 fetch.mockResolvedValue(new Response('',{status:200}));fetch.mockRejectedValueOnce(new TypeError('offline'));
 await expect(api.moveConnection('https://down.example')).rejects.toThrow(/Couldn’t reach/);
 expect(api.getApiUrl()).toBe('https://old.example');
 fetch.mockRestore();
});
