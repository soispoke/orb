import {createContext, createSignal, useContext, type JSX} from 'solid-js';
import {anchoredDisclosure} from './anchoredDisclosure';

// Owned by one transcript, so recycled rows retain their expansion without
// leaking it into another chat or keeping the rows themselves mounted.
export const DisclosureState = createContext<Map<string, boolean>>();
export function disclosure(key: string | undefined, initial = false) {
  const state = useContext(DisclosureState);
  const [open, setOpen] = createSignal((key ? state?.get(key) : undefined) ?? initial);
  const [explicit, setExplicit] = createSignal(!!key && !!state?.has(key));
  return [open, (value: boolean) => {
    if (key) state?.set(key, value);
    setExplicit(true); setOpen(value);
  }, explicit] as const;
}

/** Native keyboard/accessibility semantics with the same state and scroll
 * anchoring used by the transcript's tool disclosures. */
export function TranscriptDetails(p: {
  stateKey?: string; class: string; title?: string;
  summary: JSX.Element; children: JSX.Element;
}) {
  const [open, setOpen] = disclosure(p.stateKey);
  const anchored = anchoredDisclosure();
  return <details class={p.class} open={open()} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary title={p.title} onClick={e => {
      e.preventDefault();
      const summary = e.currentTarget;
      anchored(summary, () => setOpen(!open()));
    }}>{p.summary}</summary>
    {p.children}
  </details>;
}
