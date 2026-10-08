/**
 * DeskMCP Agent clipboard: memory-only, lease-scoped, text-only.
 * IMPORTANT: this is NOT a second Windows clipboard. It must never call
 * clipboard Win32 APIs, navigator.clipboard, clipboardy or OS copy/paste.
 */
export class AgentClipboardStore {
  private readonly slots = new Map<string, { text: string; expires: number }>();
  private readonly maxCharacters = 4096;
  private readonly ttlMs = 15 * 60 * 1000;
  private readonly leasePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

  constructor(private readonly clock: () => number = Date.now) {}

  put(leaseId: string, text: string): void {
    if (!this.leasePattern.test(leaseId)) throw new Error('Agent clipboard requires a valid bound desktop lease.');
    if (typeof text !== 'string' || text.length > this.maxCharacters) {
      throw new Error('Agent clipboard only accepts plain text up to 4096 UTF-16 code units.');
    }
    this.slots.set(leaseId.toLowerCase(), { text, expires: this.clock() + this.ttlMs });
  }

  read(leaseId: string): string {
    if (!this.leasePattern.test(leaseId)) throw new Error('Agent clipboard requires a valid bound desktop lease.');
    const key = leaseId.toLowerCase();
    const slot = this.slots.get(key);
    if (!slot || slot.expires <= this.clock()) {
      this.slots.delete(key);
      throw new Error('Agent clipboard is empty or expired. Copy into this Agent Desktop first.');
    }
    return slot.text;
  }

  clearLease(leaseId: string): void {
    if (this.leasePattern.test(leaseId)) this.slots.delete(leaseId.toLowerCase());
  }

  clearAll(): void { this.slots.clear(); }
}

/** Block OS clipboard chords during automated Agent browser input. */
export function assertNoSystemClipboardChord(key: string): void {
  const parts = key.toLowerCase().replaceAll(' ', '').split('+');
  const terminal = parts.at(-1) ?? '';
  const mods = new Set(parts.slice(0, -1));
  const control = mods.has('control') || mods.has('ctrl')
    || mods.has('controlormeta') || mods.has('meta') || mods.has('command') || mods.has('cmd');
  const shift = mods.has('shift');
  if ((control && ['c', 'v', 'x', 'insert'].includes(terminal))
    || (shift && terminal === 'insert')) {
    throw new Error('Agent Desktop OS clipboard shortcuts are blocked. Use Agent virtual_copy or virtual_paste instead.');
  }
}
