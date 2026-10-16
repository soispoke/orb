import {afterEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen} from "@solidjs/testing-library";
import {createSignal} from "solid-js";
import {LocalWorkspaceChoice} from "../src/LocalWorkspaceChoice";
import {workspacePreparation} from "../src/localWorkspaces";
afterEach(()=>{cleanup();delete (window as any).__TAURI_INTERNALS__;});
it("offers shared folder and worktree with clear file semantics",async()=>{
  const View=()=>{const [mode,setMode]=createSignal<"shared"|"worktree">("shared");return <LocalWorkspaceChoice value={mode()} disabled={false} onChange={setMode}/>;};
  render(View);
  expect(screen.getByText("Chats share files and the current branch.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Local workspace mode"),{target:{value:"worktree"}});
  expect(screen.getByText(/Uncommitted files stay in the original folder/)).toBeTruthy();
});
it("disables changes during launch",()=>{
  render(()=><LocalWorkspaceChoice value="shared" disabled onChange={()=>{}}/>);
  expect((screen.getByLabelText("Local workspace mode") as HTMLSelectElement).disabled).toBe(true);
});
it("shared folder does not create a checkout, and retries reuse the prepared worktree",async()=>{
  const invoke=vi.fn(async(_command:string,_args:any)=>"/isolated"); (window as any).__TAURI_INTERNALS__={invoke};
  const workspace=workspacePreparation();
  expect(await workspace.prepare("/source","shared")).toBe("/source"); expect(invoke).not.toHaveBeenCalled();
  expect(await workspace.prepare("/source","worktree")).toBe("/isolated");
  await workspace.prepare("/source","worktree");expect(invoke).toHaveBeenCalledTimes(1);
  await workspace.prepare("/source","shared");await workspace.prepare("/source","worktree");expect(invoke).toHaveBeenCalledTimes(1);
  const key=invoke.mock.calls[0][1].key;
  workspace.reset();await workspace.prepare("/source","worktree");expect(invoke.mock.calls[1][1].key).not.toBe(key);
});
it("retains the worktree identity after native failure and never falls back to sharing",async()=>{
  const invoke=vi.fn().mockRejectedValueOnce(Error("Git failed")).mockResolvedValue("/isolated");
  (window as any).__TAURI_INTERNALS__={invoke};const workspace=workspacePreparation();
  await expect(workspace.prepare("/source","worktree")).rejects.toThrow("Git failed");
  expect(await workspace.prepare("/source","worktree")).toBe("/isolated");
  expect(invoke.mock.calls[0][1]).toEqual(invoke.mock.calls[1][1]);
  await workspace.prepare("/other","worktree");expect(invoke.mock.calls[2][1].key).not.toBe(invoke.mock.calls[0][1].key);
});
