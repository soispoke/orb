import {nativeInvoke} from "./clientRuns";
import type {LocalWorkspaceMode} from "./LocalWorkspaceChoice";
/** Keep a prepared checkout across retries; a successful launch consumes it. */
export function workspacePreparation() {
  let current: {source:string;key:string;promise?:Promise<string>} | undefined;
  return {
    async prepare(source:string, mode:LocalWorkspaceMode):Promise<string> {
      if(mode === "shared") return source;
      if(current?.source === source && current.promise) return current.promise;
      const invoke=nativeInvoke();
      if(!invoke) throw Error("Open Orb desktop to create a worktree.");
      const key=current?.source === source ? current.key : crypto.randomUUID();
      const entry: {source:string;key:string;promise?:Promise<string>}={source,key};
      entry.promise=invoke("local_worktree",{cwd:source,key}).then(value=>String(value)).catch(error=>{
        // Failed creation can leave a useful checkout. Retrying with the same
        // identity lets native validation recover it instead of making copies.
        entry.promise=undefined;
        throw error;
      });
      current=entry;
      return entry.promise;
    },
    reset(){current=undefined;},
  };
}
