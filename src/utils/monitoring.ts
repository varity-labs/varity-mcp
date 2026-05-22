/**
 * Error tracking with Sentry
 */

import * as Sentry from "@sentry/node";

const SENTRY_DSN = process.env.SENTRY_DSN;
const NODE_ENV = process.env.NODE_ENV || "development";

/**
 * Initialize Sentry error tracking
 */
export function initSentry() {
  if (!SENTRY_DSN) {
    console.log("Sentry DSN not configured - error tracking disabled");
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: NODE_ENV,
    tracesSampleRate: NODE_ENV === "production" ? 0.1 : 1.0,
    beforeSend(event) {
      // Scrub sensitive data
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    },
  });

  console.log("Sentry error tracking initialized");
}

/**
 * Capture exception
 */
export function captureException(
  error: Error,
  context?: Record<string, any>
) {
  if (context) {
    Sentry.setContext("additional", context);
  }
  Sentry.captureException(error);
}

/**
 * Capture message
 */
export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "info"
) {
  Sentry.captureMessage(message, level);
}

/**
 * Set user context
 */
export function setUser(userId: string, email?: string) {
  Sentry.setUser({ id: userId, email });
}

/**
 * Add breadcrumb
 */
export function addBreadcrumb(
  message: string,
  category: string,
  data?: Record<string, any>
) {
  Sentry.addBreadcrumb({
    message,
    category,
    data,
    level: "info",
  });
}
