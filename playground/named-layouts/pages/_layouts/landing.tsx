export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-layout="landing" style={{ minHeight: '100vh', margin: -8 }}>
      <header
        style={{
          boxSizing: 'border-box',
          width: '100%',
          padding: '16px 24px',
          background: '#305CDE',
          color: '#ffffff',
          fontWeight: 700,
          textAlign: 'center',
        }}
      >
        Landing
      </header>
      <main style={{ padding: 16 }}>{children}</main>
    </div>
  );
}
