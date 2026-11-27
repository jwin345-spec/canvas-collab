import { ConfigError, loadConfig, loadDotEnv } from './config';
import { createLogger } from './logger';
import { createStore } from './persistence';
import { createApp } from './server';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger(config);
  if (config.usingDevSecret) {
    logger.warn('JWT_SECRET not set: using the built-in development secret');
  }

  const store = await createStore(config, logger);
  const app = createApp({ config, logger, store });
  await app.listen();

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => {
      logger.error({ timeoutMs: config.shutdownTimeoutMs }, 'graceful shutdown timed out');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    deadline.unref();
    try {
      await app.close();
      await store.close();
      logger.flush();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', (signal) => void shutdown(signal));
  process.on('SIGTERM', (signal) => void shutdown(signal));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet (bad config), so report startup failures on stderr.
  const message =
    error instanceof ConfigError ? error.message : String((error as Error).stack ?? error);
  process.stderr.write(`canvas-collab server failed to start: ${message}\n`);
  process.exit(1);
});
