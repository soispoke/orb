import {Select} from "./Select";
export type LocalWorkspaceMode = "shared" | "worktree";
export function LocalWorkspaceChoice(props: {value:LocalWorkspaceMode;disabled:boolean;onChange:(mode:LocalWorkspaceMode)=>void}) {
  return <div class="local-workspace-choice" style={{display:"flex", "flex-wrap":"wrap", gap:"8px", "align-items":"center", "font-size":"12px"}}>
    <Select aria-label="Local workspace mode" value={props.value} disabled={props.disabled}
      onChange={event=>props.onChange(event.currentTarget.value as LocalWorkspaceMode)}>
      <option value="shared">Share folder</option>
      <option value="worktree">Separate worktree</option>
    </Select>
    <span class="muted">{props.value === "shared"
      ? "Chats share files and the current branch."
      : "New branch from the current commit. Uncommitted files stay in the original folder. Requires Git."}</span>
  </div>;
}
