import {createSignal, createUniqueId, type JSX} from 'solid-js';
import './backgroundPanel.css';

/** Hiding the panel preserves its readers and expanded task rows. */
export function BackgroundPanel(p: {children: JSX.Element; tasks: JSX.Element}) {
  const [open, setOpen] = createSignal(true);
  const id = createUniqueId();
  return <div class="background-layout" data-open={open()}>
    <div class="background-conversation">
      <div class="background-toolbar"><button aria-controls={id} aria-expanded={open()} onClick={() => setOpen(v => !v)}>Background tasks <span aria-hidden="true">{open() ? '›' : '‹'}</span></button></div>
      {p.children}
    </div>
    <aside id={id} class="background-panel" aria-label="Background tasks" hidden={!open()}>
      <header><span>Background tasks</span><button aria-label="Close background tasks" onClick={() => setOpen(false)}>×</button></header>
      <div class="background-panel-body">{p.tasks}<p class="background-panel-empty">Agents and background commands will appear here when they start.</p></div>
    </aside>
  </div>;
}
