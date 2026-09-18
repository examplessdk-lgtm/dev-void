import type { Props } from './account.server.ts';

export default function AccountPage({ methods, error }: Props) {
  return (
    <main className="wrapper px-10 py-12">
      <h1>Linked login methods</h1>
      <p>
        Sign in to your existing account again before linking another method. You will review and
        confirm the new identity before it is linked.
      </p>
      {error && <p>{error}</p>}
      {methods.map((method) => (
        <form key={method.id} method="post">
          <input type="hidden" name="connectionId" value={method.id} />
          <button className="button" type="submit">
            Link {method.label}
          </button>
        </form>
      ))}
      <a href="/">Back to account</a>
    </main>
  );
}
