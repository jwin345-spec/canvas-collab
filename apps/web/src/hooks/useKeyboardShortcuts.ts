import { useEffect, useRef } from 'react';

export type ShortcutMap = Record<string, (event: KeyboardEvent) => void>;

/** True when keystrokes belong to a text field rather than the canvas. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/**
 * Normalises a keyboard event to a combo string such as `mod+shift+z` or `delete`.
 * `mod` is Ctrl on Windows/Linux and Cmd on macOS.
 */
export function comboFor(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  if (!['control', 'meta', 'shift', 'alt'].includes(key)) parts.push(key);
  return parts.join('+');
}

/**
 * Global shortcuts. Handlers live in a ref so callers can pass a fresh object each render
 * without re-binding the listener.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutMap, enabled = true): void {
  const ref = useRef(shortcuts);
  useEffect(() => {
    ref.current = shortcuts;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      const handler = ref.current[comboFor(event)];
      if (handler) {
        event.preventDefault();
        handler(event);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
