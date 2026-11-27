import { join } from 'node:path';
import type { ServerConfig } from '../config';
import type { Logger } from '../logger';
import { FileStore } from './fileStore';
import { MemoryStore } from './memoryStore';
import { SqliteStore } from './sqliteStore';
import type { DocumentStore } from './types';

export type { CompactionResult, DocumentStore, StoredRoom } from './types';
export { FileStore, MemoryStore, SqliteStore };

/**
 * Builds the configured store. In `auto` mode SQLite is preferred, but if the native
 * better-sqlite3 binding cannot be loaded (no prebuilt binary for this platform/Node ABI
 * and no toolchain to compile one) the server degrades to the file store instead of
 * refusing to boot.
 */
export async function createStore(
  config: Pick<ServerConfig, 'persistence' | 'dataDir'>,
  logger: Logger,
): Promise<DocumentStore> {
  const sqliteFile = join(config.dataDir, 'canvas-collab.db');
  switch (config.persistence) {
    case 'memory':
      return new MemoryStore();
    case 'file':
      return new FileStore(config.dataDir);
    case 'sqlite':
      return SqliteStore.open(sqliteFile);
    case 'auto':
      try {
        return await SqliteStore.open(sqliteFile);
      } catch (error) {
        logger.warn({ err: error }, 'better-sqlite3 unavailable, falling back to file store');
        return new FileStore(config.dataDir);
      }
  }
}
