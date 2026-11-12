import type { SessionEventEnvelope } from "../omp/types.ts"

// One Server-scoped feed. Each subscriber has an independent bounded lag budget;
// overflowing one terminates only that connection (opencode v2 delivery law).
const CAPACITY = 4096

export class Subscriber {
  #queue: SessionEventEnvelope[] = []
  #wake: (() => void) | undefined
  #done = false
  closed = false

  offer(envelope: SessionEventEnvelope): void {
    if (this.closed) return
    if (this.#queue.length >= CAPACITY) {
      this.closed = true
      this.#queue.length = 0
      this.#wake?.()
      return
    }
    this.#queue.push(envelope)
    this.#wake?.()
  }

  close(): void {
    this.closed = true
    this.#done = true
    this.#wake?.()
  }

  async *stream(): AsyncGenerator<SessionEventEnvelope> {
    for (;;) {
      while (this.#queue.length > 0) yield this.#queue.shift()!
      if (this.#done || this.closed) return
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }
}

export class Feed {
  #subscribers = new Set<Subscriber>()

  subscribe(): Subscriber {
    const subscriber = new Subscriber()
    this.#subscribers.add(subscriber)
    return subscriber
  }

  unsubscribe(subscriber: Subscriber): void {
    subscriber.close()
    this.#subscribers.delete(subscriber)
  }

  publish(envelope: SessionEventEnvelope): void {
    if (this.#subscribers.size === 0) return
    for (const subscriber of this.#subscribers) subscriber.offer(envelope)
  }
}
