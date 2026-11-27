import type { PresenceUser } from '@canvas-collab/shared';
import type { Peer } from '../hooks/useAwarenessPeers';
import { initials } from '../lib/identity';
import styles from './PresenceBar.module.css';

export const MAX_VISIBLE_AVATARS = 5;

export interface PresenceBarProps {
  self: PresenceUser;
  peers: readonly Peer[];
}

/** Avatars of everyone in the room. A user with several tabs open is shown once. */
export function PresenceBar({ self, peers }: PresenceBarProps) {
  const others = new Map<string, PresenceUser>();
  for (const { state } of peers) {
    if (state.user.id !== self.id) others.set(state.user.id, state.user);
  }
  const everyone = [
    { ...self, isSelf: true },
    ...[...others.values()].map((u) => ({ ...u, isSelf: false })),
  ];
  const visible = everyone.slice(0, MAX_VISIBLE_AVATARS);
  const hidden = everyone.length - visible.length;

  return (
    <div className={styles.presence}>
      <ul className={styles.avatars} aria-label={`${everyone.length} people in this room`}>
        {visible.map((user) => (
          <li
            key={user.id}
            className={styles.avatar}
            style={{ background: user.color }}
            title={user.isSelf ? `${user.name} (you)` : user.name}
            aria-label={user.isSelf ? `${user.name} (you)` : user.name}
          >
            <span aria-hidden="true">{initials(user.name)}</span>
          </li>
        ))}
        {hidden > 0 && (
          <li className={`${styles.avatar} ${styles.overflow}`} aria-label={`${hidden} more`}>
            <span aria-hidden="true">+{hidden}</span>
          </li>
        )}
      </ul>
    </div>
  );
}
