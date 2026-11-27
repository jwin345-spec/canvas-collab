import { existsSync } from 'node:fs';
import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const positiveInt = z.coerce.number().int().positive();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(1234),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  JWT_SECRET: z.string().optional(),
  TOKEN_TTL_SECONDS: positiveInt.default(3600),
  ALLOW_DEV_TOKENS: booleanFromEnv.optional(),
  CORS_ORIGIN: z.string().default('*'),
  PERSISTENCE: z.enum(['auto', 'sqlite', 'file', 'memory']).default('auto'),
  DATA_DIR: z.string().min(1).default('.data'),
  COMPACTION_UPDATE_THRESHOLD: positiveInt.default(500),
  COMPACTION_INTERVAL_MS: positiveInt.default(60_000),
  ROOM_IDLE_TTL_MS: z.coerce.number().int().nonnegative().default(30_000),
  HEARTBEAT_INTERVAL_MS: positiveInt.default(15_000),
  MAX_BUFFERED_BYTES: positiveInt.default(4 * 1024 * 1024),
  MAX_MESSAGE_BYTES: positiveInt.default(2 * 1024 * 1024),
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(10_000),
});

export type PersistenceKind = z.infer<typeof EnvSchema>['PERSISTENCE'];
export type LogLevel = z.infer<typeof EnvSchema>['LOG_LEVEL'];

export interface ServerConfig {
  env: 'development' | 'production' | 'test';
  host: string;
  port: number;
  logLevel: LogLevel;
  jwtSecret: string;
  /** True when running on the built-in development secret. Never true in production. */
  usingDevSecret: boolean;
  tokenTtlSeconds: number;
  allowDevTokens: boolean;
  corsOrigin: string;
  persistence: PersistenceKind;
  dataDir: string;
  compactionUpdateThreshold: number;
  compactionIntervalMs: number;
  roomIdleTtlMs: number;
  heartbeatIntervalMs: number;
  maxBufferedBytes: number;
  maxMessageBytes: number;
  shutdownTimeoutMs: number;
}

const DEV_SECRET = 'canvas-collab-development-secret-do-not-use-in-prod';
const MIN_SECRET_LENGTH = 32;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Parses and validates configuration. Fails fast with every problem listed at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  if (e.JWT_SECRET !== undefined && e.JWT_SECRET.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (isProduction && e.JWT_SECRET === undefined) {
    throw new ConfigError('JWT_SECRET is required when NODE_ENV=production');
  }

  return {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    jwtSecret: e.JWT_SECRET ?? DEV_SECRET,
    usingDevSecret: e.JWT_SECRET === undefined,
    tokenTtlSeconds: e.TOKEN_TTL_SECONDS,
    allowDevTokens: e.ALLOW_DEV_TOKENS ?? !isProduction,
    corsOrigin: e.CORS_ORIGIN,
    persistence: e.PERSISTENCE,
    dataDir: e.DATA_DIR,
    compactionUpdateThreshold: e.COMPACTION_UPDATE_THRESHOLD,
    compactionIntervalMs: e.COMPACTION_INTERVAL_MS,
    roomIdleTtlMs: e.ROOM_IDLE_TTL_MS,
    heartbeatIntervalMs: e.HEARTBEAT_INTERVAL_MS,
    maxBufferedBytes: e.MAX_BUFFERED_BYTES,
    maxMessageBytes: e.MAX_MESSAGE_BYTES,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  };
}

/** Loads `.env` from the working directory into process.env if present (Node >= 20.12). */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
