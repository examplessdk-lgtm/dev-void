import { useState } from 'react';

interface AppProps {
  url: string;
  visitCount: number;
  blogContent?: string | null;
}

export default function App({ url, visitCount, blogContent }: AppProps) {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>Void SSR Playground</h1>
      <p>Rendered URL: {url}</p>
      <p>KV visit count: {visitCount}</p>
      {blogContent ? (
        <article>
          <pre>{blogContent}</pre>
        </article>
      ) : (
        <>
          <button type="button" onClick={() => setCount((value) => value + 1)}>
            Counter: {count}
          </button>
          <p>This page was rendered on the worker via src/main.ssr.tsx.</p>
        </>
      )}
    </main>
  );
}
