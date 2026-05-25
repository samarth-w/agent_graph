// ─── ID generation ──────────────────────────────────────────────

let counter = 0;

export function generateId(prefix: string = ''): string {
  counter++;
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}${timestamp}_${random}_${counter}`;
}

export function resetIdCounter(): void {
  counter = 0;
}
