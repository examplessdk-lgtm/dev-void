export default function ApiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-layout="api" style={{ minHeight: '100vh', margin: -8 }}>
      <header
        style={{
          boxSizing: 'border-box',
          width: '100%',
          padding: '16px 24px',
          background: '#006400',
          color: '#ffffff',
          fontWeight: 700,
          textAlign: 'center',
        }}
      >
        API
      </header>
      <main style={{ padding: 16 }}>{children}</main>
    </div>
  );
}
