import { isCI, log, spinner, type SpinnerOptions, type SpinnerResult } from '@clack/prompts';
import pc from 'picocolors';

export { pc };

/** Keep recovery commands on the same CLI when using the local checkout launcher. */
export function cliCommandName(): 'void' | 'void-dev' {
  const entryName = process.argv[1]?.split(/[\\/]/).at(-1);
  return entryName === 'void-dev' || entryName === 'void-dev.cmd' ? 'void-dev' : 'void';
}

/**
 * Terminal-safe spinner wrapper. In CI and redirected output,
 * `@clack/prompts` spinner emits DEC Private Mode cursor hide/show codes
 * (`\x1b[?25l` / `\x1b[?25h`) that render as text artifacts. This wrapper
 * replaces the spinner with plain log output.
 */
export function createSpinner(
  options?: Pick<SpinnerOptions, 'onCancel'>,
  isTerminal: boolean = process.stdout.isTTY === true,
): SpinnerResult {
  if (!isCI() && isTerminal) {
    return spinner(options);
  }

  let currentMessage = '';
  return {
    start(msg = '') {
      currentMessage = msg;
      if (msg) {
        log.step(msg);
      }
    },
    stop(msg = '') {
      if (msg) {
        log.info(msg);
      }
    },
    message(msg = '') {
      if (msg && msg !== currentMessage) {
        currentMessage = msg;
        log.step(msg);
      }
    },
    cancel(msg = '') {
      if (msg) {
        log.warn(msg);
      }
    },
    error(msg = '') {
      if (msg) {
        log.error(msg);
      }
    },
    clear() {},
    get isCancelled() {
      return false;
    },
  };
}

export function cliTitle(command: string): string {
  return pc.blue(`void ${command}`);
}

export function sectionTitle(title: string): string {
  return pc.reset(pc.blue(title));
}

export function categoryTitle(title: string): string {
  return pc.reset(pc.bold(pc.cyan(title)));
}

export function dim(text: string): string {
  return pc.dim(text);
}

export function tablePrefix(): string {
  return `${pc.gray('│')}  `;
}

/** Strip terminal control characters from text received from a platform. */
export function sanitizeTerminalText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function helpLine(command: string, description: string): string {
  return `${pc.reset(command.padEnd(34))} ${pc.dim(description)}`;
}

/**
 * Ensure a timestamp string will be parsed as UTC by `new Date()`.
 * DB timestamps lack timezone info — appends 'Z' only when no
 * existing indicator (Z, z, or numeric offset) is present.
 */
export function ensureUtc(s: string): string {
  const last = s.at(-1);
  if (last === 'Z' || last === 'z') {
    return s;
  }
  if (s.includes('+', 10)) {
    return s;
  }
  if (s.lastIndexOf('-') > 9) {
    return s;
  }
  return s + 'Z';
}
