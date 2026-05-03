export function normalizeEmail(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}
