import { config, assertConfig } from './config/env';
import * as db from './db';
import { createApp } from './app';
import { runAll } from './jobs/tasks';

async function main(): Promise<void> {
  assertConfig();
  await db.connect();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.info(`[server] TurnByTurn API listening on :${config.port} (${config.nodeEnv}${config.squadco.mock ? ', Squadco mock' : ''})`);
  });

  let timer: NodeJS.Timeout | null = null;
  if (config.jobs.inProcess) {
    // Fallback scheduler for single-instance deploys; prefer the Render Cron Job (render.yaml).
    timer = setInterval(() => runAll().catch((e: unknown) => console.error('[jobs]', e)), config.jobs.intervalSeconds * 1000);
  }

  const shutdown = (signal: NodeJS.Signals) => {
    console.info(`[server] ${signal} received, shutting down`);
    if (timer) clearInterval(timer);
    server.close(async () => {
      await db.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e: unknown) => {
  console.error('[server] failed to start', e);
  process.exit(1);
});
