import {
  S_STEP_ACTIVE,
  S_STEP_SUBMIT,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
} from '@clack/prompts';
import { pc } from './output.ts';

export interface FlagDef {
  name: string; // e.g. "--output" (include dashes)
  description: string;
  arg?: string; // e.g. "<path>" — flag takes a value
}

export type FollowUpDef =
  | {
      type: 'multi-select';
      flag: string;
      options: Array<{ value: string; label: string; selected?: boolean }>;
    }
  | {
      type: 'repeat-input';
      placeholder: string;
    };

export interface SubcommandDef {
  name: string;
  description: string;
  arg?: string; // e.g. "<name>" — shown as dim hint, enables inline text input
  hint?: string; // e.g. "login | logout | whoami" — shown dim after name
  flags?: Array<FlagDef>;
  followUp?: FollowUpDef;
}

export interface SubcommandResult {
  subcommand: string;
  arg?: string;
  flags?: Record<string, string | true>;
  extraArgs?: Array<string>;
}

export function promptSubcommand(
  command: string,
  subcommands: Array<SubcommandDef>,
): Promise<SubcommandResult | null> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;

    type Phase = 'select' | 'flags' | 'multi-select' | 'repeat-input';
    let phase: Phase = 'select';
    let cursor = 0;
    let input = '';
    let prevLineCount = 0;
    let resolved = false;

    // Accumulated state across phases
    let selectedSub: SubcommandDef | null = null;
    let selectedArg: string | undefined;
    const selectedFlags: Record<string, string | true> = {};

    // Flags phase state
    let flagStates: Array<{ enabled: boolean; value: string }> = [];

    // Multi-select phase state
    let multiSelectStates: Array<boolean> = [];

    // Repeat-input phase state
    let repeatEntries: Array<string> = [];
    let repeatInput = '';

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1B[?25l'); // hide cursor

    function clear() {
      if (prevLineCount > 0) {
        stdout.write(`\x1B[${prevLineCount}A\x1B[0J`);
      }
    }

    function render() {
      clear();
      if (phase === 'select') {
        renderSelect();
      } else if (phase === 'flags') {
        renderFlags();
      } else if (phase === 'multi-select') {
        renderMultiSelect();
      } else {
        renderRepeatInput();
      }
    }

    const title = command ? `void ${command}` : 'void';

    // Header for post-select phases
    function headerLine(): string {
      const argPart = selectedArg ? ` ${selectedArg}` : '';
      return `${pc.cyan(S_STEP_ACTIVE)}  ${pc.cyan(title)} ${pc.dim('·')} ${pc.cyan(`${selectedSub!.name}${argPart}`)}`;
    }

    // --- Renderers ---

    function renderSelect() {
      const lines: Array<string> = [];
      const focused = subcommands[cursor];

      lines.push(`${pc.cyan(S_STEP_ACTIVE)}  ${pc.cyan(title)}`);
      lines.push(pc.gray(S_BAR));

      const maxName = Math.max(...subcommands.map((s) => s.name.length));

      for (let i = 0; i < subcommands.length; i++) {
        const sub = subcommands[i];
        const isFocused = i === cursor;
        const radio = isFocused ? pc.green(S_RADIO_ACTIVE) : pc.dim(S_RADIO_INACTIVE);
        const name = sub.name.padEnd(maxName);

        let suffix = '';
        if (sub.arg) {
          if (isFocused && input.length > 0) {
            suffix = `  ${pc.cyan(input)}`;
          } else {
            suffix = `  ${pc.dim(sub.arg)}`;
          }
        } else if (sub.hint) {
          suffix = `  ${pc.dim(sub.hint)}`;
        }

        if (isFocused) {
          lines.push(`${pc.gray(S_BAR)}  ${radio} ${pc.reset(name)}${suffix}`);
        } else {
          lines.push(`${pc.gray(S_BAR)}  ${radio} ${pc.dim(name)}${suffix}`);
        }
      }

      lines.push(pc.gray(S_BAR));
      lines.push(`${pc.gray(S_BAR)}  ${pc.dim(focused.description)}`);
      if (focused.arg) {
        if (focused.arg.startsWith('<')) {
          lines.push(`${pc.gray(S_BAR)}  ${pc.dim(`Type ${focused.arg}, then press Enter`)}`);
        } else {
          lines.push(
            `${pc.gray(S_BAR)}  ${pc.dim(`Type ${focused.arg}, then press Enter, or press Enter to skip`)}`,
          );
        }
      }
      lines.push(pc.gray(S_BAR_END));

      stdout.write(lines.join('\n') + '\n');
      prevLineCount = lines.length;
    }

    function renderFlags() {
      const flags = selectedSub!.flags!;
      const focused = flags[cursor];
      const lines: Array<string> = [];

      lines.push(headerLine());
      lines.push(pc.gray(S_BAR));

      const maxFlag = Math.max(...flags.map((f) => f.name.length));

      for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        const state = flagStates[i];
        const isFocused = i === cursor;

        const checkbox = state.enabled
          ? pc.green(S_CHECKBOX_ACTIVE)
          : isFocused
            ? S_CHECKBOX_INACTIVE
            : pc.dim(S_CHECKBOX_INACTIVE);
        const name = flag.name.padEnd(maxFlag);

        let valueText = '';
        if (flag.arg) {
          if (state.enabled && state.value.length > 0) {
            valueText = `  ${isFocused ? pc.cyan(state.value) : pc.dim(state.value)}`;
          } else {
            valueText = `  ${pc.dim(flag.arg)}`;
          }
        }

        if (isFocused) {
          lines.push(`${pc.gray(S_BAR)}  ${checkbox} ${pc.reset(name)}${valueText}`);
        } else {
          lines.push(`${pc.gray(S_BAR)}  ${checkbox} ${pc.dim(name)}${valueText}`);
        }
      }

      lines.push(pc.gray(S_BAR));
      lines.push(`${pc.gray(S_BAR)}  ${pc.dim(focused.description)}`);
      lines.push(pc.gray(S_BAR_END));

      stdout.write(lines.join('\n') + '\n');
      prevLineCount = lines.length;
    }

    function renderMultiSelect() {
      const followUp = selectedSub!.followUp as Extract<FollowUpDef, { type: 'multi-select' }>;
      const options = followUp.options;
      const lines: Array<string> = [];

      lines.push(headerLine());
      lines.push(pc.gray(S_BAR));

      const maxLabel = Math.max(...options.map((o) => o.label.length));

      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const selected = multiSelectStates[i];
        const isFocused = i === cursor;

        const checkbox = selected
          ? pc.green(S_CHECKBOX_ACTIVE)
          : isFocused
            ? S_CHECKBOX_INACTIVE
            : pc.dim(S_CHECKBOX_INACTIVE);
        const label = opt.label.padEnd(maxLabel);

        if (isFocused) {
          lines.push(`${pc.gray(S_BAR)}  ${checkbox} ${pc.reset(label)}`);
        } else {
          lines.push(`${pc.gray(S_BAR)}  ${checkbox} ${pc.dim(label)}`);
        }
      }

      lines.push(pc.gray(S_BAR));
      lines.push(`${pc.gray(S_BAR)}  ${pc.dim('space to toggle, enter to confirm')}`);
      lines.push(pc.gray(S_BAR_END));

      stdout.write(lines.join('\n') + '\n');
      prevLineCount = lines.length;
    }

    function renderRepeatInput() {
      const followUp = selectedSub!.followUp as Extract<FollowUpDef, { type: 'repeat-input' }>;
      const lines: Array<string> = [];

      lines.push(headerLine());
      lines.push(pc.gray(S_BAR));

      for (const entry of repeatEntries) {
        lines.push(`${pc.gray(S_BAR)}  ${pc.dim(entry)}`);
      }

      if (repeatInput.length > 0) {
        lines.push(`${pc.gray(S_BAR)}  ${pc.cyan(repeatInput)}`);
      } else {
        lines.push(`${pc.gray(S_BAR)}  ${pc.dim(followUp.placeholder)}`);
      }

      lines.push(pc.gray(S_BAR));
      lines.push(`${pc.gray(S_BAR)}  ${pc.dim('enter to add, empty to finish')}`);
      lines.push(pc.gray(S_BAR_END));

      stdout.write(lines.join('\n') + '\n');
      prevLineCount = lines.length;
    }

    // --- Lifecycle ---

    function cleanup() {
      if (resolved) {
        return;
      }
      resolved = true;
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\x1B[?25h'); // show cursor
    }

    function submit(result: SubcommandResult | null) {
      cleanup();
      clear();

      if (result) {
        let summary = result.subcommand;
        if (result.arg) {
          summary += ` ${result.arg}`;
        }
        if (result.flags) {
          for (const [flag, value] of Object.entries(result.flags)) {
            summary += ` ${flag}`;
            if (typeof value === 'string') {
              summary += ` ${value}`;
            }
          }
        }
        if (result.extraArgs && result.extraArgs.length > 0) {
          summary += ` ${result.extraArgs.join(' ')}`;
        }
        stdout.write(
          `${pc.gray(S_STEP_SUBMIT)}  ${pc.dim(title)} ${pc.dim('·')} ${pc.dim(summary)}\n`,
        );
      }

      resolve(result);
    }

    function finalize() {
      const result: SubcommandResult = {
        subcommand: selectedSub!.name,
        arg: selectedArg,
      };

      if (Object.keys(selectedFlags).length > 0) {
        result.flags = { ...selectedFlags };
      }

      if (repeatEntries.length > 0) {
        result.extraArgs = repeatEntries;
      }

      submit(result);
    }

    function advancePhase() {
      // After choosing a command, try flags first.
      if (phase === 'select' && selectedSub!.flags && selectedSub!.flags.length > 0) {
        phase = 'flags';
        cursor = 0;
        flagStates = selectedSub!.flags!.map(() => ({ enabled: false, value: '' }));
        render();
        return;
      }

      // Then try any follow-up input phase.
      if ((phase === 'select' || phase === 'flags') && selectedSub!.followUp) {
        const followUp = selectedSub!.followUp;
        if (followUp.type === 'multi-select') {
          phase = 'multi-select';
          cursor = 0;
          multiSelectStates = followUp.options.map((o) => !!o.selected);
          render();
          return;
        }
        if (followUp.type === 'repeat-input') {
          phase = 'repeat-input';
          repeatEntries = [];
          repeatInput = '';
          render();
          return;
        }
      }

      finalize();
    }

    // --- Key handlers ---

    function handleSelectKey(key: string) {
      const focused = subcommands[cursor];

      // Up
      if (key === '\x1B[A' || key === '\x1BOA') {
        cursor = cursor === 0 ? subcommands.length - 1 : cursor - 1;
        input = '';
        render();
        return;
      }
      // Down
      if (key === '\x1B[B' || key === '\x1BOB') {
        cursor = (cursor + 1) % subcommands.length;
        input = '';
        render();
        return;
      }

      // Enter
      if (key === '\r' || key === '\n') {
        const argRequired = focused.arg && focused.arg.startsWith('<');
        if (argRequired && input.length === 0) {
          return;
        }
        selectedSub = focused;
        selectedArg = focused.arg ? input || undefined : undefined;
        clear();
        advancePhase();
        return;
      }

      // Backspace
      if (key === '\x7F' || key === '\b') {
        if (focused.arg && input.length > 0) {
          input = input.slice(0, -1);
          render();
        }
        return;
      }

      // Printable characters — only if focused subcommand has arg
      if (focused.arg && key.length === 1 && key >= ' ') {
        input += key;
        render();
      }
    }

    function handleFlagKey(key: string) {
      const flags = selectedSub!.flags!;
      const focused = flags[cursor];
      const state = flagStates[cursor];

      // Up
      if (key === '\x1B[A' || key === '\x1BOA') {
        cursor = cursor === 0 ? flags.length - 1 : cursor - 1;
        render();
        return;
      }
      // Down
      if (key === '\x1B[B' || key === '\x1BOB') {
        cursor = (cursor + 1) % flags.length;
        render();
        return;
      }

      // Space — toggle flag
      if (key === ' ') {
        state.enabled = !state.enabled;
        if (!state.enabled) {
          state.value = '';
        }
        render();
        return;
      }

      // Enter — advance
      if (key === '\r' || key === '\n') {
        // Block if any enabled value flag has empty value
        for (let i = 0; i < flags.length; i++) {
          if (flagStates[i].enabled && flags[i].arg && flagStates[i].value.length === 0) {
            return;
          }
        }

        // Collect enabled flags
        for (let i = 0; i < flags.length; i++) {
          if (flagStates[i].enabled) {
            selectedFlags[flags[i].name] = flags[i].arg ? flagStates[i].value : true;
          }
        }

        clear();
        advancePhase();
        return;
      }

      // Backspace — delete char from value
      if (key === '\x7F' || key === '\b') {
        if (focused.arg && state.enabled && state.value.length > 0) {
          state.value = state.value.slice(0, -1);
          render();
        }
        return;
      }

      // Printable characters — type value for enabled value flag (auto-enables)
      if (focused.arg && key.length === 1 && key >= ' ') {
        if (!state.enabled) {
          state.enabled = true;
        }
        state.value += key;
        render();
      }
    }

    function handleMultiSelectKey(key: string) {
      const followUp = selectedSub!.followUp as Extract<FollowUpDef, { type: 'multi-select' }>;
      const options = followUp.options;

      // Up
      if (key === '\x1B[A' || key === '\x1BOA') {
        cursor = cursor === 0 ? options.length - 1 : cursor - 1;
        render();
        return;
      }
      // Down
      if (key === '\x1B[B' || key === '\x1BOB') {
        cursor = (cursor + 1) % options.length;
        render();
        return;
      }

      // Space — toggle
      if (key === ' ') {
        multiSelectStates[cursor] = !multiSelectStates[cursor];
        render();
        return;
      }

      // Enter — submit
      if (key === '\r' || key === '\n') {
        const selected = options.filter((_, i) => multiSelectStates[i]);
        if (selected.length === 0) {
          return;
        }
        selectedFlags[followUp.flag] = selected.map((o) => o.value).join(',');
        clear();
        finalize();
        return;
      }
    }

    function handleRepeatInputKey(key: string) {
      // Enter — add entry or finish
      if (key === '\r' || key === '\n') {
        if (repeatInput.length > 0) {
          repeatEntries.push(repeatInput);
          repeatInput = '';
          render();
        } else {
          clear();
          finalize();
        }
        return;
      }

      // Backspace
      if (key === '\x7F' || key === '\b') {
        if (repeatInput.length > 0) {
          repeatInput = repeatInput.slice(0, -1);
          render();
        }
        return;
      }

      // Printable characters
      if (key.length === 1 && key >= ' ') {
        repeatInput += key;
        render();
      }
    }

    function handleKey(key: string) {
      if (resolved) {
        return;
      }

      if (phase === 'select') {
        handleSelectKey(key);
      } else if (phase === 'flags') {
        handleFlagKey(key);
      } else if (phase === 'multi-select') {
        handleMultiSelectKey(key);
      } else {
        handleRepeatInputKey(key);
      }
    }

    // --- Main event handler ---

    function onData(data: Buffer) {
      if (resolved) {
        return;
      }
      const key = data.toString();

      // Ctrl+C
      if (key === '\x03') {
        submit(null);
        return;
      }
      // Escape
      if (key === '\x1B' && data.length === 1) {
        submit(null);
        return;
      }
      // Arrow keys and other escape sequences need to stay grouped.
      if (key.startsWith('\x1B')) {
        handleKey(key);
        return;
      }

      for (const char of key) {
        if (char === '\x03') {
          submit(null);
          return;
        }
        handleKey(char);
      }
    }

    stdin.on('data', onData);

    // Safety cleanup on exit
    process.on('exit', () => {
      if (!resolved) {
        stdout.write('\x1B[?25h');
      }
    });

    render();
  });
}
