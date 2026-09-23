'use strict';

const { ZodError } = require('zod');
const { User } = require('../models');
const { ApiError, err } = require('../utils/errors');
const { verifyJwt } = require('../services/tokens');
const { config } = require('../config/env');

/** Wraps async handlers so rejections reach the error middleware. */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Requires a valid access token; loads req.user. SESSION_EXPIRED when the JWT has expired. */
const auth = h(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw err('UNAUTHENTICATED');
  const payload = verifyJwt(token, 'access');
  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active') throw err('SESSION_EXPIRED');
  if (user.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime() - 1000) {
    throw err('SESSION_EXPIRED');
  }
  req.user = user;
  next();
});

const adminOnly = (req, _res, next) => {
  if (!req.user || !req.user.isAdmin) return next(err('ACCESS_DENIED', 'Staff only.'));
  return next();
};

/** Parses req[part] with a zod schema, replacing it with the parsed value. */
const validate = (schema, part = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[part]);
  if (!r.success) return next(r.error);
  req[part] = r.data;
  return next();
};

function notFound(req, _res, next) {
  next(err('NOT_FOUND', `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(e, req, res, _next) {
  if (e instanceof ZodError) {
    const details = e.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    const isPassword = details.some((d) => d.field === 'password' || d.field === 'newPassword');
    const code = isPassword ? 'PASSWORD_POLICY' : 'VALIDATION_ERROR';
    const api = new ApiError(code, isPassword ? undefined : details[0] && `${details[0].field}: ${details[0].message}`);
    return res.status(api.status).json({ error: { code: api.code, message: api.message, details } });
  }
  if (e && e.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body.' } });
  }
  if (e && e.name === 'MulterError') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: e.message } });
  }
  if (e instanceof ApiError) {
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    const body = { code: e.code, message: e.message };
    if (e.details) body.details = e.details;
    if (e.retryAfter) body.retryAfter = e.retryAfter;
    return res.status(e.status).json({ error: body });
  }
  if (e && e.name === 'CastError') {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  }
  if (e && e.code === 11000) {
    return res.status(409).json({ error: { code: 'CONFLICT', message: 'That record already exists.' } });
  }
  console.error(`[error] ${req.method} ${req.originalUrl}`, e);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.', ...(config.isProd ? {} : { debug: e.message }) },
  });
}

module.exports = { h, auth, adminOnly, validate, notFound, errorHandler };
