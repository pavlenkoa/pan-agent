/**
 * One JSON object per stdout line — picked up by fluent-bit -> Loki with zero
 * pipeline changes (architecture doc section 7). Every call site supplies
 * `evt` plus whatever fields are relevant; nothing here enforces a fixed
 * schema beyond that.
 */

export type LogFields = Record<string, unknown>;

const MAX_TEXT_BYTES = 1024;

/** Truncate long text fields to keep Loki lines browsable; records original length. */
export function truncateText(text: string): { text: string; bytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_TEXT_BYTES) return { text, bytes };
  // Truncate on a byte boundary that's still valid UTF-8 by working on the buffer.
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_TEXT_BYTES);
  return { text: buf.toString('utf8'), bytes };
}

const LOG_THINKING = process.env['LOG_THINKING'] === 'true';

export function logLine(evt: string, fields: LogFields = {}): void {
  if (evt === 'thinking' && !LOG_THINKING) return;
  const line = { evt, ts: new Date().toISOString(), ...fields };
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  line: logLine,
  error(evt: string, err: unknown, fields: LogFields = {}): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logLine(evt, { ...fields, ok: false, error: message, stack });
  },
};
