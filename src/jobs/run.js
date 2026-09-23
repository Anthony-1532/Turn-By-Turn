'use strict';

/** Entry point for the Render Cron Job: `node src/jobs/run.js`. */

const { assertConfig } = require('../config/env');
const db = require('../db');
const { runAll } = require('./tasks');

(async () => {
  assertConfig();
  await db.connect();
  const started = Date.now();
  const result = await runAll();
  console.info(`[jobs] done in ${Date.now() - started}ms`, JSON.stringify(result));
  await db.disconnect();
  process.exit(Object.values(result).some((r) => r && r.error) ? 1 : 0);
})().catch((e) => {
  console.error('[jobs] fatal', e);
  process.exit(1);
});
