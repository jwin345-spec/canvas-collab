import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionBadge } from '../src/components/ConnectionBadge';
import { MAX_VISIBLE_AVATARS, PresenceBar } from '../src/components/PresenceBar';
import { Toolbar, type ToolbarProps } from '../src/components/Toolbar';
import type { Peer } from '../src/hooks/useAwarenessPeers';

function renderToolbar(overrides: Partial<ToolbarProps> = {}) {
  const props: ToolbarProps = {
    tool: 'select',
    onToolChange: vi.fn(),
    canUndo: false,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    hasSelection: false,
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<Toolbar {...props} />);
  return props;
}

describe('Toolbar', () => {
  it('exposes tools as toggle buttons in a labelled toolbar', () => {
    renderToolbar({ tool: 'rect' });
    const toolbar = screen.getByRole('toolbar', { name: 'Board tools' });
    expect(within(toolbar).getByRole('button', { name: 'Rectangle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(toolbar).getByRole('button', { name: 'Select' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Sticky note' })).toHaveAttribute(
      'aria-keyshortcuts',
      'S',
    );
  });

  it('reports tool changes', async () => {
    const props = renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: 'Connector' }));
    expect(props.onToolChange).toHaveBeenCalledWith('connector');
  });

  it('disables history and delete actions when unavailable', async () => {
    const props = renderToolbar({ canUndo: true });
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete selection' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(props.onUndo).toHaveBeenCalledOnce();
  });
});

describe('ConnectionBadge', () => {
  it.each([
    ['connected', true, 'Live'],
    ['connected', false, 'Syncing…'],
    ['connecting', false, 'Connecting…'],
    ['disconnected', false, 'Offline — edits will sync on reconnect'],
  ] as const)('shows %s (synced=%s) as "%s"', (status, synced, label) => {
    render(<ConnectionBadge status={status} synced={synced} />);
    expect(screen.getByRole('status')).toHaveTextContent(label);
  });
});

function peer(clientId: number, id: string, name: string): Peer {
  return {
    clientId,
    state: { user: { id, name, color: '#3b82f6' }, cursor: null, selection: [] },
  };
}

describe('PresenceBar', () => {
  const self = { id: 'me', name: 'Calm Heron', color: '#ef4444' };

  it('lists the local user and peers, deduplicating multiple tabs', () => {
    render(
      <PresenceBar
        self={self}
        peers={[
          peer(1, 'ada', 'Ada Lovelace'),
          peer(2, 'ada', 'Ada Lovelace'),
          peer(3, 'me', 'Calm Heron'),
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: '2 people in this room' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Calm Heron (you)',
      'Ada Lovelace',
    ]);
    expect(items[1]).toHaveTextContent('AL');
  });

  it('collapses overflow into a counter', () => {
    const many = Array.from({ length: 8 }, (_, i) => peer(i + 1, `u${i}`, `User ${i}`));
    render(<PresenceBar self={self} peers={many} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_VISIBLE_AVATARS + 1);
    expect(screen.getByLabelText(`${9 - MAX_VISIBLE_AVATARS} more`)).toBeInTheDocument();
  });
});
