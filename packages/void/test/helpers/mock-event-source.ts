/** EventSource stand-in that records every instance and lets tests dispatch events. */
export class MockEventSource {
  static instances: Array<MockEventSource> = [];

  readonly listeners: Map<string, Set<(event: Event) => void>> = new Map();
  closed = false;

  constructor(
    readonly url: string,
    readonly options?: { withCredentials?: boolean },
  ) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Dispatches `event`; a string is sent as the `data` of a message event. */
  emit(type: string, event: Event | string, lastEventId = ''): void {
    const payload =
      typeof event === 'string' ? ({ data: event, lastEventId } as MessageEvent) : event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }

  close(): void {
    this.closed = true;
  }
}
