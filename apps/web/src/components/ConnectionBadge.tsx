import type { ConnectionStatus } from '@canvas-collab/shared/client';
import styles from './ConnectionBadge.module.css';

export interface ConnectionBadgeProps {
  status: ConnectionStatus;
  synced: boolean;
}

type Tone = 'live' | 'pending' | 'offline';

function describeConnection({ status, synced }: ConnectionBadgeProps): {
  label: string;
  tone: Tone;
} {
  if (status === 'connected') {
    return synced ? { label: 'Live', tone: 'live' } : { label: 'Syncing…', tone: 'pending' };
  }
  if (status === 'connecting') return { label: 'Connecting…', tone: 'pending' };
  return { label: 'Offline — edits will sync on reconnect', tone: 'offline' };
}

/** Connection state, announced politely to screen readers when it changes. */
export function ConnectionBadge(props: ConnectionBadgeProps) {
  const { label, tone } = describeConnection(props);
  return (
    <div role="status" aria-live="polite" className={styles.badge} data-tone={tone}>
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </div>
  );
}
