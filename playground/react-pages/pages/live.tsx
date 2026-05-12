import { useEffect, useMemo, useState } from 'react';
import type { LiveClientEvent } from 'void/live';
import { connectLiveStream } from 'void/live/client';
import type { Props } from './live.server.ts';

type PlaygroundEvent = {
  text: string;
  sentAt: string;
};

type Status = 'connecting' | 'connected' | 'closed' | 'error';

export default function LivePage({ topic }: Props) {
  const [status, setStatus] = useState<Status>('connecting');
  const [message, setMessage] = useState('Hello from the browser');
  const [events, setEvents] = useState<Array<LiveClientEvent<PlaygroundEvent>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const endpoint = '/api/live';

  useEffect(() => {
    const stream = connectLiveStream(endpoint, {
      retryDelay: 500,
      onError(errorEvent) {
        setStatus('error');
        setError(errorEvent instanceof Error ? errorEvent.message : 'Live stream error');
      },
    });
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | undefined;

    stream
      .subscribe<PlaygroundEvent>({
        id: 'react-pages-live-demo',
        topic,
        onEvent(event) {
          setEvents((current) => [event, ...current].slice(0, 12));
          setStatus('connected');
          setError(null);
        },
      })
      .then((fn) => {
        if (cancelled) {
          void fn();
          return;
        }
        unsubscribe = fn;
        setStatus('connected');
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      setStatus('closed');
      void unsubscribe?.();
      stream.close();
    };
  }, [topic]);

  const statusLabel = useMemo(() => {
    switch (status) {
      case 'connecting':
        return 'Connecting';
      case 'connected':
        return 'Connected';
      case 'closed':
        return 'Closed';
      case 'error':
        return 'Error';
    }
  }, [status]);

  async function publish() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/live/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      setMessage('');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <h1>Live Streams</h1>
      <p>
        Topic: <code>{topic}</code>
      </p>
      <p>Status: {statusLabel}</p>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void publish();
        }}
      >
        <label>
          Message: <input value={message} onChange={(event) => setMessage(event.target.value)} />
        </label>{' '}
        <button type="submit" disabled={pending}>
          {pending ? 'Publishing...' : 'Publish'}
        </button>
      </form>

      <h2>Events</h2>
      {events.length === 0 ? (
        <p>No events yet. Publish a message to see it fan out over SSE.</p>
      ) : (
        <ol>
          {events.map((event, index) => (
            <li key={event.eventId ?? index}>
              <strong>{event.data.text}</strong>{' '}
              <small>
                {event.type ?? 'message'} · {event.eventId ?? 'no event id'} · {event.data.sentAt}
              </small>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
