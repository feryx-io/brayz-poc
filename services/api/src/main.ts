import { loadConfig } from '@brayz/config';
import { buildApp } from './app.js';

async function main() {
  const cfg = loadConfig();
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: '0.0.0.0', port: cfg.API_PORT });
  } catch (err) {
    app.log.error(err, 'Failed to start API');
    process.exit(1);
  }
}

void main();
