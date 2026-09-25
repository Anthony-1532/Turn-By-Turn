/** Entry point for the Render Cron Job: `node dist/jobs/run.js` (`npm run jobs`). */

import { assertConfig } from '../config/env';
import * as db from '../db';
import { runAll, hasFailures } from './tasks';

async function main(): Promise<void> {
  assertConfig();
  await db.connect();
  const started = Date.now();
  const result = await runAll();
  console.info(`[jobs] done in ${Date.now() - started}ms`, JSON.stringify(result));
  await db.disconnect();
  process.exit(hasFailures(result) ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error('[jobs] fatal', e);
  process.exit(1);
});
