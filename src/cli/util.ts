import fs from 'fs';
import { CliUsageError, readStdin } from './args.js';
import { getHealth } from '../core/canvas-client.js';

// Results go to stdout as JSON; diagnostics belong on stderr.
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function note(message: string): void {
  process.stderr.write(message + '\n');
}

// Screenshot / mermaid / viewport need a browser tab rendering the canvas.
// This pre-check is just a heads-up note now: the server auto-opens a tab on
// demand, and a genuine failure arrives as its 503 (BROWSER_REQUIRED) through
// requestJson.
export async function requireBrowserClient(what: string): Promise<void> {
  const health = await getHealth();
  if ((health.canvas_clients ?? health.websocket_clients) === 0) {
    note('No browser tab on this canvas yet; the server will try to open one.');
  }
}

// Read JSON input from a positional file argument or stdin ("-" = stdin).
export async function readJsonInput(file: string | undefined, what: string): Promise<any> {
  const raw = file !== undefined && file !== '-' ? fs.readFileSync(file, 'utf-8') : await readStdin();
  if (!raw.trim()) {
    throw new CliUsageError(`No ${what} provided (pass a file argument or pipe JSON to stdin)`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CliUsageError(`Invalid JSON ${what}: ${(error as Error).message}`);
  }
}
