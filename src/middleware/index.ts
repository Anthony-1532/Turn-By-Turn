import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { User, type UserDoc } from '../models';
import { ApiError, err } from '../utils/errors';
import { verifyJwt } from '../services/tokens';
import { config } from '../config/env';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the `auth` middleware. Read it through `currentUser(req)`. */
      user?: UserDoc;
    }
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

/** Wraps async handlers so rejections reach the error middleware. */
export const h =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/** The signed-in user. Only valid on routes behind `auth`. */
export function currentUser(req: Request): UserDoc {
  if (!req.user) throw err('UNAUTHENTICATED');
  return req.user;
}

/** Parses and returns the request body; throws a ZodError (→ 400/422) on failure. */
export function parseBody<S extends ZodTypeAny>(schema: S, req: Request): z.output<S> {
  return schema.parse(req.body ?? {});
}

export function parseQuery<S extends ZodTypeAny>(schema: S, req: Request): z.output<S> {
  return schema.parse(req.query);
}

/** String route param (Express types params loosely). */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== 'string') throw err('NOT_FOUND');
  return v;
}

/** Requires a valid access token; loads req.user. SESSION_EXPIRED when the JWT has expired. */
export const auth: RequestHandler = h(async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw err('UNAUTHENTICATED');
  const payload = verifyJwt(token, 'access');
  const user = await User.findById(payload.sub);
  if (!user || user.status !== 'active') throw err('SESSION_EXPIRED');
  if (user.passwordChangedAt && (payload.iat ?? 0) * 1000 < user.passwordChangedAt.getTime() - 1000) {
    throw err('SESSION_EXPIRED');
  }
  req.user = user;
  next();
});

export const adminOnly: RequestHandler = (req, _res, next) => {
  if (!req.user?.isAdmin) return next(err('ACCESS_DENIED', 'Staff only.'));
  return next();
};

export const notFound: RequestHandler = (req, _res, next) => {
  next(err('NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  retryAfter?: number;
  debug?: string;
}

const isRecord = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null;

export function errorHandler(e: unknown, req: Request, res: Response, _next: NextFunction): void {
  const send = (status: number, body: ErrorBody) => {
    res.status(status).json({ error: body });
  };
  if (e instanceof ZodError) {
    const details = e.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    const isPassword = details.some((d) => d.field === 'password' || d.field === 'newPassword');
    const api = isPassword
      ? new ApiError('PASSWORD_POLICY')
      : new ApiError('VALIDATION_ERROR', details[0] && `${details[0].field}: ${details[0].message}`);
    return send(api.status, { code: api.code, message: api.message, details });
  }
  if (e instanceof ApiError) {
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    const body: ErrorBody = { code: e.code, message: e.message };
    if (e.details !== undefined) body.details = e.details;
    if (e.retryAfter) body.retryAfter = e.retryAfter;
    return send(e.status, body);
  }
  if (isRecord(e)) {
    if (e.type === 'entity.parse.failed') return send(400, { code: 'VALIDATION_ERROR', message: 'Malformed JSON body.' });
    if (e.name === 'MulterError') return send(400, { code: 'VALIDATION_ERROR', message: String(e.message) });
    if (e.name === 'CastError') return send(404, { code: 'NOT_FOUND', message: 'Not found.' });
    if (e.code === 11000) return send(409, { code: 'CONFLICT', message: 'That record already exists.' });
  }
  console.error(`[error] ${req.method} ${req.originalUrl}`, e);
  const body: ErrorBody = { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
  if (!config.isProd && e instanceof Error) body.debug = e.message;
  return send(500, body);
}
