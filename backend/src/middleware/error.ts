import { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { env } from "../config/env";

/** 404 for anything the router did not claim. */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.originalUrl}` },
  });
}

/**
 * The single exit point for failures. Clients learn the code and a message they
 * can act on; stack traces, Postgres internals and revert data stay in the log.
 */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.error("Request failed", {
        path: req.path,
        code: error.code,
        message: error.message,
        details: error.details,
      });
    } else {
      logger.debug("Request refused", { path: req.path, code: error.code, message: error.message });
    }

    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.expose ? error.message : "Something went wrong. Please try again.",
        ...(error.expose && error.details !== undefined ? { details: error.details } : {}),
      },
    });
  }

  if (error instanceof MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? `That file is larger than the ${Math.round(env.MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`
        : `Upload rejected: ${error.code}`;
    return res.status(400).json({ error: { code: "UPLOAD_REJECTED", message } });
  }

  if (error instanceof SyntaxError && "body" in error) {
    return res
      .status(400)
      .json({ error: { code: "BAD_JSON", message: "The request body is not valid JSON." } });
  }

  logger.error("Unhandled error", {
    path: req.path,
    method: req.method,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
  });

  return res.status(500).json({
    error: { code: "INTERNAL", message: "Something went wrong. Please try again." },
  });
}

/** Lets route handlers be plain async functions without try/catch noise. */
export function asyncRoute<T extends Request = Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req as T, res, next).catch(next);
  };
}
