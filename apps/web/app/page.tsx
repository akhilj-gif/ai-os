// M0 UI shell: proves web ↔ api ↔ substrate wiring. The real OS interface
// (dashboard, task inspector, memory browser, approvals) is M8.
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Health = { ok: boolean; milestone: string; services: Record<string, string> };

async function getHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${API}/health`, { cache: 'no-store' });
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

function Chip({ name, status }: { name: string; status: string }) {
  const ok = status === 'ok';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 24,
        padding: '10px 16px',
        borderRadius: 8,
        background: '#14162200',
        border: `1px solid ${ok ? '#1f4d3a' : '#5c2a33'}`,
      }}
    >
      <span style={{ color: '#9aa0b5' }}>{name}</span>
      <span style={{ color: ok ? '#4ade80' : '#f87171' }}>{ok ? '● ok' : `● ${status}`}</span>
    </div>
  );
}

export default async function Home() {
  const health = await getHealth();
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '80px 24px' }}>
      <p style={{ color: '#4b78ff', letterSpacing: 2, fontSize: 12, margin: 0 }}>
        MILESTONE {health?.milestone ?? 'M0'}
      </p>
      <h1 style={{ fontSize: 40, margin: '8px 0 4px' }}>AI OS</h1>
      <p style={{ color: '#9aa0b5', marginTop: 0 }}>
        Kernel skeleton — every request traced, five contracts live.
      </p>
      <div style={{ display: 'grid', gap: 8, marginTop: 32 }}>
        <Chip name="api" status={health ? 'ok' : 'unreachable'} />
        {health &&
          Object.entries(health.services).map(([name, status]) => (
            <Chip key={name} name={name} status={status} />
          ))}
      </div>
    </main>
  );
}
