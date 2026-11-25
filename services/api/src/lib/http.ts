import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodSchema } from 'zod';

/** Application error carrying an HTTP status. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    /** Structured extras a client can act on (e.g. duplicate findings), merged into the error body. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`, 'not_found');
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg, 'forbidden');
export const unauthorized = (msg = 'Unauthorized') => new HttpError(401, msg, 'unauthorized');
export const conflict = (msg = 'Conflict') => new HttpError(409, msg, 'conflict');

/** Validate and return typed data, or throw a 400 HttpError with field details. */
export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(result.error);
  }
  return result.data;
}

export class ValidationError extends HttpError {
  constructor(public readonly zodError: ZodError) {
    super(400, 'Validation failed', 'validation_error');
    this.name = 'ValidationError';
  }
}

/** Central Fastify error handler — maps our errors and Zod issues to JSON. */
export function errorHandler(
  err: unknown,
  _req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (err instanceof ValidationError) {
    return reply.status(400).send({
      error: { code: 'validation_error', message: 'Validation failed', issues: err.zodError.issues },
    });
  }
  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: { code: 'validation_error', message: 'Validation failed', issues: err.issues },
    });
  }
  if (err instanceof HttpError) {
    return reply
      .status(err.statusCode)
      .send({ error: { code: err.code ?? 'error', message: err.message, ...(err.details ?? {}) } });
  }
  // Fastify raises its own client errors (malformed JSON, empty body on a
  // content-type: application/json request, payload too large). They already
  // carry the right status and blaming the server for them sends a caller
  // hunting a bug on our side instead of fixing their request.
  const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
  if (
    typeof fastifyErr?.statusCode === 'number' &&
    fastifyErr.statusCode >= 400 &&
    fastifyErr.statusCode < 500
  ) {
    return reply.status(fastifyErr.statusCode).send({
      error: { code: fastifyErr.code ?? 'bad_request', message: fastifyErr.message ?? 'Bad request' },
    });
  }
  reply.log.error({ err }, 'Unhandled error');
  return reply.status(500).send({ error: { code: 'internal', message: 'Internal server error' } });
}
