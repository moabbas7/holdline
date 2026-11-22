import { confirm as confirmPrompt, input as inputPrompt } from '@inquirer/prompts';

type Paint = (s: string) => string;
export interface Colors {
  red: Paint;
  green: Paint;
  yellow: Paint;
  cyan: Paint;
  dim: Paint;
  bold: Paint;
}

/** All user interaction goes through this, so commands can run headless in tests. */
export interface Io {
  /** Prompts are possible (stdin and stdout are TTYs). */
  interactive: boolean;
  c: Colors;
  log(msg?: string): void;
  warn(msg: string): void;
  /** A transient status line (overwritten by the next progressDone on a TTY). */
  progress(msg: string): void;
  progressDone(msg: string): void;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  /** Prompt with `prefill` as editable text. */
  input(message: string, prefill: string): Promise<string>;
}

const ansi = (open: number, close: number): Paint => (s) => `\x1b[${open}m${s}\x1b[${close}m`;
const identity: Paint = (s) => s;

export function makeColors(enabled: boolean): Colors {
  return enabled
    ? { red: ansi(31, 39), green: ansi(32, 39), yellow: ansi(33, 39), cyan: ansi(36, 39), dim: ansi(2, 22), bold: ansi(1, 22) }
    : { red: identity, green: identity, yellow: identity, cyan: identity, dim: identity, bold: identity };
}

/**
 * Real terminal IO. With `json`, human-readable output goes to stderr so stdout
 * carries only the JSON document.
 */
export function createCliIo(opts: { json?: boolean } = {}): Io {
  const out = opts.json ? process.stderr : process.stdout;
  const tty = Boolean(out.isTTY);
  const colors = makeColors(tty && !process.env.NO_COLOR);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    interactive,
    c: colors,
    log: (msg = '') => out.write(msg + '\n'),
    warn: (msg) => process.stderr.write(colors.yellow(msg) + '\n'),
    progress: (msg) => {
      if (tty) out.write(`\x1b[2K\r${msg}`);
    },
    progressDone: (msg) => out.write((tty ? '\x1b[2K\r' : '') + msg + '\n'),
    confirm: (message, defaultValue) => confirmPrompt({ message, default: defaultValue }),
    input: (message, prefill) => inputPrompt({ message, default: prefill, prefill: 'editable' }),
  };
}
