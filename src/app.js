'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const { config } = require('./config/env');
const { notFound, errorHandler, h } = require('./middleware');
const { err } = require('./utils/errors');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render terminates TLS in front of us
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
      credentials: false,
    }),
  );
  if (!config.isTest) app.use(morgan(config.isProd ? 'combined' : 'dev'));

  // Webhooks need the raw body for signature checks, so they are mounted before express.json.
  app.use('/api/v1/webhooks', require('./routes/webhooks'));
  app.use(express.json({ limit: '200kb' }));

  // Render health check
  app.get('/health', (_req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ status: dbUp ? 'ok' : 'degraded', db: dbUp ? 'up' : 'down', time: new Date().toISOString() });
  });

  // API docs
  app.get('/api/v1/openapi.json', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'openapi.json')));
  app.get('/api/v1/docs', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><title>TurnByTurn API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div><script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/api/v1/openapi.json',dom_id:'#ui'})</script></body></html>`);
  });

  const api = express.Router();
  api.use('/auth', require('./routes/auth'));
  api.use('/users', require('./routes/users'));
  api.use('/groups', require('./routes/groups'));
  api.use('/admin', require('./routes/admin'));
  api.use('/', require('./routes/public'));
  if (config.devRoutes) api.use('/dev', require('./routes/dev'));
  // Cron trigger for hosts that prefer an HTTP call over a Render Cron Job.
  api.post(
    '/internal/jobs/run',
    h(async (req, res) => {
      if (!config.jobs.cronSecret || req.get('x-cron-secret') !== config.jobs.cronSecret) throw err('ACCESS_DENIED');
      res.json(await require('./jobs/tasks').runAll());
    }),
  );

  // Everything below requires a signed-in user.
  api.use('/', require('./routes/money'));
  api.use('/', require('./routes/account'));

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
