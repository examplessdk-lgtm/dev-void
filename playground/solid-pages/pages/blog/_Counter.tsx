import { createSignal } from 'solid-js';

export default function Counter(props: { initial?: number }) {
  const [count, setCount] = createSignal(props.initial ?? 0);
  return (
    <div>
      <span data-testid="count">Count: {count()}</span>
      <button onClick={() => setCount((c) => c + 1)}>Increment</button>
    </div>
  );
}
