import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { config } from './config/env';
import { notFound, errorHandler, h } from './middleware';
import { err } from './utils/errors';
import webhooksRoutes from './routes/webhooks';
import authRoutes from './routes/auth';
import usersRoutes from './routes/users';
import groupsRoutes from './routes/groups';
import adminRoutes from './routes/admin';
import publicRoutes from './routes/public';
import devRoutes from './routes/dev';
import moneyRoutes from './routes/money';
import accountRoutes from './routes/account';
import { runAll } from './jobs/tasks';

export function createApp(): express.Express {
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
  app.use('/api/v1/webhooks', webhooksRoutes);
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
  api.use('/auth', authRoutes);
  api.use('/users', usersRoutes);
  api.use('/groups', groupsRoutes);
  api.use('/admin', adminRoutes);
  api.use('/', publicRoutes);
  if (config.devRoutes) api.use('/dev', devRoutes);
  // Cron trigger for hosts that prefer an HTTP call over a Render Cron Job.
  api.post(
    '/internal/jobs/run',
    h(async (req, res) => {
      if (!config.jobs.cronSecret || req.get('x-cron-secret') !== config.jobs.cronSecret) throw err('ACCESS_DENIED');
      res.json(await runAll());
    }),
  );

  // Everything below requires a signed-in user.
  api.use('/', moneyRoutes);
  api.use('/', accountRoutes);

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

