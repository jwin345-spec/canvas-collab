import type { ReactNode } from 'react';
import { TOOLS, type Tool } from '../lib/tools';
import styles from './Toolbar.module.css';

const ICONS: Record<Tool | 'undo' | 'redo' | 'delete', ReactNode> = {
  select: <path d="M5 3l14 8-6 1.5L10 19z" />,
  sticky: <path d="M4 4h16v10l-6 6H4zM14 20v-6h6" />,
  rect: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
  ellipse: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />,
  connector: <path d="M4 18L18 6m0 0h-6m6 0v6" />,
  undo: <path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" />,
  redo: <path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h2" />,
  delete: <path d="M5 7h14M10 7V4h4v3m-7 0l1 13h8l1-13" />,
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

export interface ToolbarProps {
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  hasSelection: boolean;
  onDelete: () => void;
}

export function Toolbar({
  tool,
  onToolChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  hasSelection,
  onDelete,
}: ToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Board tools"
      aria-orientation="vertical"
      className={styles.toolbar}
    >
      {TOOLS.map(({ id, label, shortcut }) => (
        <button
          key={id}
          type="button"
          className={styles.button}
          aria-label={label}
          aria-pressed={tool === id}
          aria-keyshortcuts={shortcut}
          title={`${label} (${shortcut})`}
          onClick={() => onToolChange(id)}
        >
          <Icon name={id} />
        </button>
      ))}
      <hr className={styles.divider} />
      <button
        type="button"
        className={styles.button}
        aria-label="Undo"
        aria-keyshortcuts="Control+Z"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Icon name="undo" />
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Redo"
        aria-keyshortcuts="Control+Shift+Z"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Icon name="redo" />
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Delete selection"
        aria-keyshortcuts="Delete"
        title="Delete (Del)"
        disabled={!hasSelection}
        onClick={onDelete}
      >
        <Icon name="delete" />
      </button>
    </div>
  );
}
