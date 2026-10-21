import {render, fireEvent, screen, cleanup} from '@solidjs/testing-library';
import {afterEach, expect, it} from 'vitest';
import {BackgroundPanel} from '../src/BackgroundPanel';
afterEach(() => {cleanup();localStorage.clear();});
it('keeps the panel closed across chat remounts and returns focus to its toggle', () => {
  const view = () => <BackgroundPanel tasks={<div>Task details</div>}><div>Conversation</div></BackgroundPanel>;
  render(view);
  const close = screen.getByRole('button',{name:'Close background tasks'});
  close.focus(); fireEvent.click(close);
  expect(screen.getByRole('button',{name:'Background tasks'})).toBe(document.activeElement);
  expect(screen.getByRole('button',{name:'Background tasks'}).getAttribute('aria-expanded')).toBe('false');
  cleanup();render(view);
  expect(screen.getByRole('button',{name:'Background tasks'}).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button',{name:'Background tasks'}));
  expect(screen.getByRole('complementary').hidden).toBe(false);
});
