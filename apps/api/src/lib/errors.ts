export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'BAD_REQUEST', msg, details);
export const unauthorized = (msg = 'authentication required') => new HttpError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (msg = 'forbidden', code = 'FORBIDDEN') => new HttpError(403, code, msg);
export const notFound = (msg = 'not found') => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string) => new HttpError(409, 'CONFLICT', msg);
export const unprocessable = (msg: string, details?: unknown) => new HttpError(422, 'UNPROCESSABLE', msg, details);
