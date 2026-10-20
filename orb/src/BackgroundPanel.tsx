import {createSignal, createUniqueId, onCleanup, onMount, type JSX} from 'solid-js';
import './backgroundPanel.css';

const TASKS = '.subagents, .agent-activity';

/** Hiding the panel preserves its readers and expanded task rows. */
export function BackgroundPanel(p: {children: JSX.Element; tasks: JSX.Element}) {
  const [open, setOpen] = createSignal((() => {try {return localStorage.getItem('orb.backgroundPanel.open') !== 'false';} catch {return true;}})());
  // An empty panel stays out of the conversation's way unless asked for.
  const [hasTasks, setHasTasks] = createSignal(false);
  const [requested, setRequested] = createSignal(false);
  const shown = () => open() && (hasTasks() || requested());
  let toggle!: HTMLButtonElement;
  let body!: HTMLDivElement;
  const changeOpen = (value: boolean) => {
    setOpen(value);
    setRequested(value);
    try {localStorage.setItem('orb.backgroundPanel.open', String(value));} catch { /* Storage can be unavailable in private contexts. */ }
  };
  onMount(() => {
    const check = () => setHasTasks(!!body.querySelector(TASKS));
    check();
    const observer = new MutationObserver(check);
    observer.observe(body, {childList: true, subtree: true});
    onCleanup(() => observer.disconnect());
  });
  const id = createUniqueId();
  return <div class="background-shell"><div class="background-layout" data-open={shown()}>
    <div class="background-conversation">
      <div class="background-toolbar"><button ref={toggle} aria-controls={id} aria-expanded={shown()} onClick={() => changeOpen(!shown())}>Background tasks <span aria-hidden="true">{shown() ? '›' : '‹'}</span></button></div>
      {p.children}
    </div>
    <aside id={id} class="background-panel" aria-label="Background tasks" hidden={!shown()}>
      <header><span>Background tasks</span><button aria-label="Close background tasks" onClick={() => {changeOpen(false); toggle.focus({preventScroll:true});}}>×</button></header>
      <div ref={body} class="background-panel-body">{p.tasks}<p class="background-panel-empty">No background tasks to show. Current commands appear in the conversation.</p></div>
    </aside>
  </div></div>;
}
