import { captureException as captureSentry, captureMessage as sentryMessage } from './sentry.js'
let posthog: any = null

export async function initMonitoring(): Promise<void> {
  const key = process.env.POSTHOG_KEY || process.env.POSTHOG_API_KEY || process.env.POSTHOG_TOKEN
  const host = process.env.POSTHOG_HOST || process.env.POSTHOG_API_HOST || 'https://app.posthog.com'
  if (!key) {
    console.info('[monitoring] PostHog not configured (POSTHOG_KEY missing)')
    return
  }

  try {
    // dynamic import so package is optional
    const { PostHog } = await import('posthog-node')
    posthog = new PostHog(key, { host })
    console.info('[monitoring] PostHog initialized')
  } catch (err) {
    console.warn('[monitoring] posthog-node not installed or failed to initialize')
  }
}

/**
 * Capture an exception to Sentry and emit a PostHog event for server-side analysis.
 */
export function captureException(err: unknown, ctx?: Record<string, unknown>) {
  // Send to Sentry first
  try {
    captureSentry(err, ctx)
  } catch (e) {
    // ignore
  }

  // Also emit to PostHog as an event so we can run funnels/alerts there
  try {
    if (posthog) {
      const props: Record<string, unknown> = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        ...(ctx || {}),
      }
      posthog.capture({ distinctId: 'server', event: 'server_error', properties: props })
    }
  } catch (e) {
    // ignore
  }
}

export function captureEvent(name: string, properties?: Record<string, unknown>) {
  try {
    sentryMessage(name, 'info')
  } catch (e) { /* noop */ }
  try {
    if (posthog) posthog.capture({ distinctId: 'server', event: name, properties: properties || {} })
  } catch (e) { /* noop */ }
}

export function getPosthogClient() { return posthog }
