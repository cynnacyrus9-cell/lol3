import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveClient, type ConnectionState } from '../../src/lib/live-client'
import type { ServerMessage } from '../../shared/types'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(m: ServerMessage | 'pong') {
    this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) })
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
  fail() {
    this.readyState = 3
    this.onclose?.()
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }
  close() {
    this.closed = true
  }
}

const live = (seq: number) => ({ t: 'live', live: { seq } }) as unknown as ServerMessage

function make() {
  const states: ConnectionState[] = []
  const messages: ServerMessage[] = []
  const client = new LiveClient({
    wsUrl: 'wss://x/api/live',
    sseUrl: '/api/stream',
    onMessage: (m) => messages.push(m),
    onState: (s) => states.push(s),
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
    random: () => 0.5,
  })
  return { client, states, messages }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  FakeEventSource.instances = []
})
afterEach(() => vi.useRealTimers())

describe('LiveClient', () => {
  it('connects, delivers messages and reports LIVE', () => {
    const { client, states, messages } = make()
    client.start()
    FakeSocket.instances[0].open()
    FakeSocket.instances[0].message(live(5))
    expect(states.at(-1)).toBe('live')
    expect(messages).toHaveLength(1)
    expect(client.seq).toBe(5)
  })

  it('reconnects with exponential backoff and resumes from the last sequence number', () => {
    const { client, states } = make()
    client.setSeq(3)
    client.start()
    expect(FakeSocket.instances[0].url).toBe('wss://x/api/live?since=3')
    FakeSocket.instances[0].open()
    FakeSocket.instances[0].message({ t: 'event', event: { seq: 9 } } as unknown as ServerMessage)
    FakeSocket.instances[0].fail()
    expect(states.at(-1)).toBe('reconnecting')
    vi.advanceTimersByTime(999)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(FakeSocket.instances[1].url).toBe('wss://x/api/live?since=9')
    FakeSocket.instances[1].fail()
    vi.advanceTimersByTime(1999)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('sends keep-alive pings and drops a silent connection', () => {
    const { client, states } = make()
    client.start()
    const ws = FakeSocket.instances[0]
    ws.open()
    vi.advanceTimersByTime(25_000)
    expect(ws.sent).toContain('ping')
    ws.message('pong')
    vi.advanceTimersByTime(25_000 + 10_000)
    // second ping got no answer within 10 s
    expect(ws.readyState).toBe(3)
    expect(states).toContain('reconnecting')
  })

  it('falls back to Server-Sent Events after repeated WebSocket failures', () => {
    const { client, states } = make()
    client.start()
    for (let i = 0; i < 3; i++) {
      FakeSocket.instances.at(-1)!.fail()
      vi.advanceTimersByTime(60_000)
    }
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(states).toContain('fallback')
    FakeEventSource.instances[0].onmessage?.({ data: JSON.stringify(live(12)) })
    expect(client.seq).toBe(12)
  })

  it('stops cleanly', () => {
    const { client, states } = make()
    client.start()
    FakeSocket.instances[0].open()
    client.stop()
    expect(states.at(-1)).toBe('offline')
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})
