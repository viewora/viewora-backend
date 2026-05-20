import { PostHog } from 'posthog-node'

let _client: PostHog | null = null

function getPosthog(): PostHog | null {
  if (!process.env.POSTHOG_API_KEY) return null
  if (!_client) {
    _client = new PostHog(process.env.POSTHOG_API_KEY, {
      host: 'https://us.i.posthog.com',
      flushAt: 10,
      flushInterval: 5000,
    })
  }
  return _client
}

export function trackServer(userId: string, event: string, properties?: Record<string, any>) {
  const ph = getPosthog()
  if (!ph) return
  ph.capture({ distinctId: userId, event, properties })
}
