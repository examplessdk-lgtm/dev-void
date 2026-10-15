export type TerminalTone = 'base' | 'muted' | 'blue' | 'green' | 'yellow' | 'red';

export const playbackSpeeds = [0.75, 1, 1.5, 2] as const;

export interface TerminalSegment {
  text: string;
  tone?: TerminalTone;
  bold?: boolean;
}

export interface TerminalLine {
  id: string;
  segments: Array<TerminalSegment>;
  spinner?: boolean;
  caret?: boolean;
}

export type TerminalEvent =
  | { at: number; type: 'write'; line: TerminalLine }
  | { at: number; type: 'remove'; id: string }
  | {
      at: number;
      type: 'type';
      id: string;
      text: string;
      duration: number;
      prefix?: Array<TerminalSegment>;
      tone?: TerminalTone;
    };

export interface TerminalDemo {
  id: string;
  label: string;
  title: string;
  description: string;
  directory: string;
  command: string;
  duration: number;
  events: Array<TerminalEvent>;
  link: string;
  linkLabel: string;
  context: string;
}

/** Replaying from time zero makes scrubbing and replay independent of frame rate. */
export function terminalFrame(demo: TerminalDemo, elapsed: number): Array<TerminalLine> {
  const lines = new Map<string, TerminalLine>();
  const time = Math.max(0, Math.min(demo.duration, elapsed));
  for (const event of demo.events) {
    if (event.at > time) {
      break;
    }
    if (event.type === 'remove') {
      lines.delete(event.id);
    } else if (event.type === 'write') {
      lines.set(event.line.id, event.line);
    } else {
      const characters = Array.from(event.text);
      const progress = Math.min(1, (time - event.at) / event.duration);
      lines.set(event.id, {
        id: event.id,
        caret: progress < 1,
        segments: [
          ...(event.prefix ?? []),
          {
            text: characters.slice(0, Math.floor(progress * characters.length)).join(''),
            tone: event.tone,
          },
        ],
      });
    }
  }
  return [...lines.values()];
}

/** An anchored clock preserves position when pausing or changing playback speed. */
export class PlaybackClock {
  private position = 0;
  private anchor = 0;
  private rate = 1;
  private running = false;

  readonly duration: number;

  constructor(duration: number) {
    this.duration = duration;
  }

  get playing(): boolean {
    return this.running;
  }
  get speed(): number {
    return this.rate;
  }

  read(now: number): number {
    return Math.min(
      this.duration,
      this.position + (this.running ? (now - this.anchor) * this.rate : 0),
    );
  }

  play(now: number): void {
    if (this.running) {
      return;
    }
    this.anchor = now;
    this.running = true;
  }

  pause(now: number): void {
    this.position = this.read(now);
    this.running = false;
  }

  seek(position: number, now: number): void {
    this.position = Math.max(0, Math.min(this.duration, position));
    this.anchor = now;
  }

  setSpeed(speed: number, now: number): void {
    if (!Number.isFinite(speed) || speed <= 0) {
      return;
    }
    this.position = this.read(now);
    this.anchor = now;
    this.rate = speed;
  }
}
