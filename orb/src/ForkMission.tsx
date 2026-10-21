import {CodexSpeedPicker,missionSpeed,requireSpeedSupport} from './CodexSpeedPicker';
import {createConversationFork,localForkSource} from './forkConversation';
import type {CodexServiceTier} from './api';
import { ErrorDialog, workspaceConflict } from "./ErrorNotice";
import { DialogButton } from "./Dialog";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { connectionVersion, getMission, shortModelLabel, type HarnessChoice, type Mission } from "./api";
import { effortLabel, supportedEfforts } from "./effort";
import { Menu } from "./Menu";

export function ForkMission(p: { mission: Mission; choices: HarnessChoice[]; destination: string; anchor?: HTMLElement; onOpen?: () => void; onClose: () => void; onFork: (mission: Mission) => void }) {
  const [backend, setBackend] = createSignal(p.mission.backend ?? p.choices[0]?.backend.id ?? "");
  const [speed,setSpeed]=createSignal<CodexServiceTier>(missionSpeed(p.mission));
  const [model, setModel] = createSignal(p.mission.model_override ?? "");
  const [modelAnchor, setModelAnchor] = createSignal<HTMLButtonElement>();
  const [effortAnchor, setEffortAnchor] = createSignal<HTMLButtonElement>();
  const [busy, setBusy] = createSignal(false), [error, setError] = createSignal("");
  const choices = () => p.choices.find(choice => choice.backend.id === backend())?.models ?? [];
  const unavailable = (id: string) => !!p.mission.remote_node_id && !["codex", "grok", "claudecode", "opencode", "antigravity", "vibe"].includes(id);
  let key = crypto.randomUUID(), visit = 0, disposed = false;
  let forkConversation = createConversationFork();
  const scope = createMemo(() => JSON.stringify([connectionVersion(), p.mission.id]));
  createEffect(() => {
    scope(); visit++;
    untrack(() => {
      key = crypto.randomUUID(); forkConversation = createConversationFork();
      setBusy(false); setError(""); setModelAnchor(undefined); setEffortAnchor(undefined);
      setBackend(p.mission.backend ?? p.choices[0]?.backend.id ?? "");
      setModel(p.mission.model_override ?? ""); setSpeed(missionSpeed(p.mission));
    });
  });
  onCleanup(() => { disposed = true; });
  const currentVisit = () => {
    const started = visit, identity = scope();
    return () => !disposed && started === visit && identity === scope();
  };
  onMount(() => p.onOpen?.());
  const fork = async (effort = "") => {
    if (busy() || !backend() || unavailable(backend()) || !choices().some(choice => choice.value === model())) return;
    const source = p.mission, current = currentVisit(), launch = forkConversation;
    const request = { backend: backend(), model_override: model(), model_effort: effort, service_tier:backend()==="codex"?speed():undefined, idempotency_key: key };
    setBusy(true); setError("");
    try {
      if(request.backend==="codex")await requireSpeedSupport(request.model_override,request.service_tier!,undefined,localForkSource(source));
      if(!current())return;
      const result = await launch(source, request);
      if(current())p.onFork(result);
    }
    catch (e) {if(current())setError(e instanceof Error ? e.message : String(e));}
    finally {if(current())setBusy(false);}
  };
  const openExisting = async () => {
    const id = workspaceConflict(error())?.missionId;
    if (!id || busy()) return;
    const current = currentVisit();
    setBusy(true);
    try { const mission = await getMission(id); if(current())p.onFork(mission); }
    catch (e) { if(current())setError(e instanceof Error ? e.message : String(e)); }
    finally { if(current())setBusy(false); }
  };
  const openModels = (id: string, anchor: HTMLButtonElement) => {
    if (busy() || unavailable(id)) return;
    if(id!==backend())setSpeed('standard');
    setBackend(id); setEffortAnchor(undefined); setModelAnchor(anchor);
  };
  return <Menu label="Fork conversation" class="fork-harnesses" anchor={p.anchor} placement={p.anchor ? "right-start" : "top-start"} busy={busy()} onClose={p.onClose}>
    <Show when={!p.anchor}><div class="menu-group">Fork conversation</div></Show>
    <For each={p.choices}>{choice => <button type="button" class="menu-item" role="menuitem" aria-haspopup="menu" aria-expanded={!!modelAnchor() && backend() === choice.backend.id} disabled={busy() || unavailable(choice.backend.id)}
      title={unavailable(choice.backend.id) ? "Not supported on this remote workspace" : choice.backend.name}
      onMouseEnter={e => openModels(choice.backend.id, e.currentTarget)} onClick={e => openModels(choice.backend.id,e.currentTarget)}
      onKeyDown={e => {if(e.key === "ArrowRight"){e.preventDefault();e.stopPropagation();openModels(choice.backend.id,e.currentTarget);}}}>
      {choice.backend.name}<span class="menu-chevron" aria-hidden="true">›</span>
    </button>}</For>
    <Show when={modelAnchor()}>{anchor => <Menu label="Choose a model" class="fork-models" anchor={anchor()} placement="right-start" busy={busy()} onClose={() => setModelAnchor(undefined)}>
      <For each={choices()}>{choice => {
        const choose = (anchor: HTMLButtonElement) => {if (busy()) return; setModel(choice.value); if (supportedEfforts(backend(), choice.efforts).length) setEffortAnchor(anchor); else void fork();};
        return <button type="button" class="menu-item" role="menuitem" disabled={busy()} aria-haspopup={supportedEfforts(backend(), choice.efforts).length ? "menu" : undefined}
          title={`Fork into ${shortModelLabel(choice.label)} · same workspace on ${p.destination}`}
          onClick={e => choose(e.currentTarget)} onMouseEnter={e => {if (!busy()) {setModel(choice.value);setEffortAnchor(supportedEfforts(backend(), choice.efforts).length ? e.currentTarget : undefined);}}}
          onKeyDown={e => {if(e.key === "ArrowRight" && supportedEfforts(backend(), choice.efforts).length){e.preventDefault();e.stopPropagation();choose(e.currentTarget);}}}>
          {shortModelLabel(choice.label)}<Show when={supportedEfforts(backend(), choice.efforts).length}><span class="menu-chevron" aria-hidden="true">›</span></Show>
        </button>;
      }}</For>
      <Show when={!choices().length}><div class="menu-group">No models available</div></Show>
      <Show when={effortAnchor()}>{anchor => <Menu label="Choose effort" class="fork-effort-menu" anchor={anchor()} placement="right-start" busy={busy()} onClose={() => setEffortAnchor(undefined)}>
        <Show when={backend()==="codex"}><CodexSpeedPicker model={model()} value={speed()} local={localForkSource(p.mission)} disabled={busy()} onChange={setSpeed}/></Show>
        <For each={["", ...supportedEfforts(backend(), choices().find(c => c.value === model())?.efforts)]}>{effort => <button type="button" role="menuitem" class="menu-item" disabled={busy()} onClick={() => void fork(effort)}>{effortLabel(effort || undefined,backend(),model())}</button>}</For>

      </Menu>}</Show>

    </Menu>}</Show>
    <Show when={error()}><ErrorDialog error={error()} busy={busy()} onClose={() => setError("")}
      actions={<Show when={workspaceConflict(error())?.missionId}><DialogButton variant="primary" disabled={busy()} onClick={() => void openExisting()}>{busy() ? "Opening…" : "Open existing chat"}</DialogButton></Show>}/></Show>
    <Show when={busy()}><div class="menu-group" role="status">Forking…</div></Show>
  </Menu>;
}
