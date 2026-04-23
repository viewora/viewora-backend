// Sentry error monitoring — activates when SENTRY_DSN env var is set.
// Uses dynamic ESM import() — safe in "type":"module" projects without @sentry/node installed.

let _sentry: any = null

export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    _sentry = await import(/* @vite-ignore */ ('@sentry/node' as string))
    _sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'production',
      tracesSampleRate: 0.1,
    })
    console.info('[sentry] error monitoring active')
  } catch {
    console.warn('[sentry] @sentry/node not installed — run npm install to enable error reporting')
  }
}

export function captureException(err: unknown, ctx?: Record<string, unknown>): void {
  if (!_sentry) return
  if (ctx) {
    _sentry.withScope((scope: any) => { scope.setExtras(ctx); _sentry.captureException(err) })
  } else {
    _sentry.captureException(err)
  }
}

export function captureMessage(msg: string, level?: 'info' | 'warning' | 'error'): void {
  _sentry?.captureMessage(msg, level ?? 'info')
}

export async function flushSentry(timeout = 2000): Promise<void> {
  if (_sentry?.close) await _sentry.close(timeout)
}
