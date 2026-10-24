import type { ServerMessage } from '@shared/types'

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'fallback' | 'offline'

export interface LiveClientOptions {
  wsUrl: string
  sseUrl: string
  onMessage: (msg: ServerMessage) => void
  onState: (state: ConnectionState, info: { attempts: number; nextRetryAt: number | null; transport: 'ws' | 'sse' | null }) => void
  WebSocketImpl?: typeof WebSocket
  EventSourceImpl?: typeof EventSource
  pingMs?: number
  pongTimeoutMs?: number
  maxBackoffMs?: number
  /** Consecutive failed WebSocket opens before trying Server-Sent Events. */
  sseAfterFailures?: number
  random?: () => number
}

/**
 * Resilient live connection:
 *  - WebSocket with keep-alive pings (answered by the Durable Object runtime
 *    without waking it), liveness timeout and exponential backoff with jitter.
 *  - Resumes with ?since=<last seq> so the server replays missed events.
 *  - Falls back to Server-Sent Events if WebSockets keep failing to open.
 */
export class LiveClient {
  private ws: WebSocket | null = null
  private es: EventSource | null = null
  private attempts = 0
  private openFailures = 0
  private lastSeq = 0
  private stopped = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private livenessTimer: ReturnType<typeof setTimeout> | null = null
  private transport: 'ws' | 'sse' | null = null
  private readonly o: Required<Omit<LiveClientOptions, 'WebSocketImpl' | 'EventSourceImpl'>> & Pick<LiveClientOptions, 'WebSocketImpl' | 'EventSourceImpl'>

  constructor(options: LiveClientOptions) {
    this.o = {
      pingMs: 25_000,
      pongTimeoutMs: 10_000,
      maxBackoffMs: 30_000,
      sseAfterFailures: 3,
      random: Math.random,
      ...options,
    }
  }

  get seq(): number {
    return this.lastSeq
  }

  /** Seeds the resume cursor (e.g. from the REST bootstrap) before start(). */
  setSeq(seq: number): void {
    this.lastSeq = Math.max(this.lastSeq, seq)
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.ws?.close(1000, 'client stop')
    this.es?.close()
    this.ws = null
    this.es = null
    this.o.onState('offline', { attempts: this.attempts, nextRetryAt: null, transport: null })
  }

  /** Reconnect immediately (e.g. the browser came back online). */
  kick(): void {
    if (this.stopped) return
    if (this.ws && this.ws.readyState === 1) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.connect()
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    this.retryTimer = null
    this.pingTimer = null
    this.livenessTimer = null
  }

  private url(base: string): string {
    if (!this.lastSeq) return base
    return `${base}${base.includes('?') ? '&' : '?'}since=${this.lastSeq}`
  }

  private connect(): void {
    this.clearTimers()
    if (this.openFailures >= this.o.sseAfterFailures && this.o.EventSourceImpl !== undefined) {
      this.connectSse()
      return
    }
    const WS = this.o.WebSocketImpl ?? WebSocket
    this.o.onState(this.attempts === 0 ? 'connecting' : 'reconnecting', { attempts: this.attempts, nextRetryAt: null, transport: 'ws' })
    let opened = false
    let ws: WebSocket
    try {
      ws = new WS(this.url(this.o.wsUrl))
    } catch {
      this.openFailures++
      this.scheduleRetry()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      opened = true
      this.attempts = 0
      this.openFailures = 0
      this.transport = 'ws'
      this.o.onState('live', { attempts: 0, nextRetryAt: null, transport: 'ws' })
      this.pingTimer = setInterval(() => {
        try {
          ws.send('ping')
        } catch {
          // ignore; liveness timer will reconnect
        }
        this.armLiveness(ws)
      }, this.o.pingMs)
    }
    ws.onmessage = (ev) => {
      if (this.livenessTimer) clearTimeout(this.livenessTimer)
      this.livenessTimer = null
      if (ev.data === 'pong') return
      this.handle(String(ev.data))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (!opened) this.openFailures++
      if (!this.stopped) this.scheduleRetry()
    }
    ws.onerror = () => {
      // onclose follows and handles the retry
    }
  }

  private armLiveness(ws: WebSocket) {
    if (this.livenessTimer) clearTimeout(this.livenessTimer)
    this.livenessTimer = setTimeout(() => {
      // No pong or message: the connection is dead even if the socket looks open.
      try {
        ws.close(4000, 'liveness timeout')
      } catch {
        // ignore
      }
      if (this.ws === ws) {
        this.ws = null
        this.scheduleRetry()
      }
    }, this.o.pongTimeoutMs)
  }

  private connectSse(): void {
    const ES = this.o.EventSourceImpl ?? EventSource
    this.o.onState('fallback', { attempts: this.attempts, nextRetryAt: null, transport: 'sse' })
    const es = new ES(this.url(this.o.sseUrl), { withCredentials: true })
    this.es = es
    this.transport = 'sse'
    es.onmessage = (ev) => {
      this.attempts = 0
      this.handle(String(ev.data))
    }
    es.onerror = () => {
      // The server closes SSE streams periodically; EventSource reconnects by itself,
      // but we re-open manually so the `since` cursor is always current.
      es.close()
      if (this.es !== es) return
      this.es = null
      if (!this.stopped) {
        // Every fifth retry, try WebSockets again in case the network recovered.
        if (this.attempts % 5 === 4) this.openFailures = 0
        this.scheduleRetry()
      }
    }
  }

  private handle(text: string) {
    let msg: ServerMessage
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg.t === 'hello' || msg.t === 'live') this.lastSeq = Math.max(this.lastSeq, msg.live.seq)
    if (msg.t === 'event') this.lastSeq = Math.max(this.lastSeq, msg.event.seq)
    if (msg.t === 'hello') for (const e of msg.missed) this.lastSeq = Math.max(this.lastSeq, e.seq)
    this.o.onMessage(msg)
  }

  private scheduleRetry() {
    this.clearTimers()
    this.attempts++
    const base = Math.min(this.o.maxBackoffMs, 1000 * 2 ** Math.min(this.attempts - 1, 10))
    const delay = Math.round(base * (0.75 + this.o.random() * 0.5))
    const nextRetryAt = Date.now() + delay
    this.o.onState('reconnecting', { attempts: this.attempts, nextRetryAt, transport: this.transport })
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }
}
