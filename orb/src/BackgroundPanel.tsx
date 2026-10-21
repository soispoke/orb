import {createSignal, createUniqueId, type JSX} from 'solid-js';
import './backgroundPanel.css';

/** Hiding the panel preserves its readers and expanded task rows. */
export function BackgroundPanel(p: {children: JSX.Element; tasks: JSX.Element}) {
  const [open, setOpen] = createSignal((() => {try {return localStorage.getItem('orb.backgroundPanel.open') !== 'false';} catch {return true;}})());
  let toggle!: HTMLButtonElement;
  const changeOpen = (value: boolean) => {
    setOpen(value);
    try {localStorage.setItem('orb.backgroundPanel.open', String(value));} catch { /* Storage can be unavailable in private contexts. */ }
  };
  const id = createUniqueId();
  return <div class="background-shell"><div class="background-layout" data-open={open()}>
    <div class="background-conversation">
      <div class="background-toolbar"><button ref={toggle} aria-controls={id} aria-expanded={open()} onClick={() => changeOpen(!open())}>Background tasks <span aria-hidden="true">{open() ? '›' : '‹'}</span></button></div>
      {p.children}
    </div>
    <aside id={id} class="background-panel" aria-label="Background tasks" hidden={!open()}>
      <header><span>Background tasks</span><button aria-label="Close background tasks" onClick={() => {changeOpen(false); toggle.focus({preventScroll:true});}}>×</button></header>
      <div class="background-panel-body">{p.tasks}<p class="background-panel-empty">No background tasks to show. Current commands appear in the conversation.</p></div>
    </aside>
  </div></div>;
}
