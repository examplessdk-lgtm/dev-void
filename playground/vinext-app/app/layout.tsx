export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>vinext App Router + Void</title>
      </head>
      <body>
        <nav style={{ padding: '8px', display: 'flex', gap: '16px' }}>
          <a href="/">Home</a>
          <a href="/smoke">Smoke</a>
        </nav>
        <hr />
        {children}
      </body>
    </html>
  );
}
