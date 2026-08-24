export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-layout="docs" style={{ minHeight: '100vh', margin: -8 }}>
      <header
        style={{
          boxSizing: 'border-box',
          width: '100%',
          padding: '16px 24px',
          background: '#FFCE1B',
          color: '#ffffff',
          fontWeight: 700,
          textAlign: 'center',
        }}
      >
        Docs
      </header>
      <main style={{ padding: 16 }}>{children}</main>
    </div>
  );
}
