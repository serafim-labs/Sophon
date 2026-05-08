/**
 * Tiny ANSI styling layer + spinner. No deps.
 *
 * Honours the usual env contracts:
 *   NO_COLOR=1   — never colorize
 *   FORCE_COLOR=1 — always colorize (even when piped)
 *   default      — colorize when stderr is a TTY
 *
 * In --json mode the events module already suppresses human() output,
 * so we never reach here from a JSON pipeline. No need to thread the
 * mode through.
 */

const NO_COLOR = process.env.NO_COLOR != null && process.env.NO_COLOR !== ''
const FORCE_COLOR = process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== ''

function shouldColor(): boolean {
  if (NO_COLOR) return false
  if (FORCE_COLOR) return true
  return process.stderr.isTTY === true
}

function wrap(open: string, close: string): (s: string) => string {
  return (s: string) => (shouldColor() ? `\x1b[${open}m${s}\x1b[${close}m` : s)
}

export const bold = wrap('1', '22')
export const dim = wrap('2', '22')
export const underline = wrap('4', '24')

export const red = wrap('31', '39')
export const green = wrap('32', '39')
export const yellow = wrap('33', '39')
export const blue = wrap('34', '39')
export const magenta = wrap('35', '39')
export const cyan = wrap('36', '39')
export const grey = wrap('90', '39')

/** Brand name in section headers — `@sophonai/bridge`. */
export function brand(text: string): string {
  return bold(cyan(text))
}

/** A muted "info" arrow used for transient one-liners. */
export const arrow = (): string => dim('→')

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface SpinnerHandle {
  /** Update the trailing label without restarting the spinner. */
  update(label: string): void
  /** Stop and clear the line. */
  stop(): void
  /** Stop and replace the line with a permanent message (for failures). */
  fail(line: string): void
  /** Stop and replace the line with a checkmark line (for successes). */
  succeed(line: string): void
}

/**
 * Start a spinner on stderr. Returns a no-op handle on non-TTY so calls
 * remain safe in CI/headless. Caller decides what to print on success/
 * fail — we only own the spinner line itself.
 */
export function spinner(initial: string): SpinnerHandle {
  const tty = process.stderr.isTTY === true && shouldColor()
  if (!tty) {
    // Non-TTY: print every label change as a fresh line. Caller will
    // typically also invoke succeed()/fail() at terminal points.
    process.stderr.write(`  ${initial}\n`)
    let last = initial
    return {
      update: (label) => {
        if (label === last) return
        last = label
        process.stderr.write(`  ${label}\n`)
      },
      stop: () => {},
      fail: (line) => process.stderr.write(`  ${line}\n`),
      succeed: (line) => process.stderr.write(`  ${line}\n`),
    }
  }

  let label = initial
  let frame = 0
  const render = () => {
    process.stderr.write(`\x1b[2K\r  ${cyan(SPINNER_FRAMES[frame]!)} ${label}`)
  }
  render()
  const id = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length
    render()
  }, 80)
  const clearLine = () => process.stderr.write('\x1b[2K\r')
  return {
    update: (l) => {
      label = l
      render()
    },
    stop: () => {
      clearInterval(id)
      clearLine()
    },
    fail: (line) => {
      clearInterval(id)
      clearLine()
      process.stderr.write(`  ${line}\n`)
    },
    succeed: (line) => {
      clearInterval(id)
      clearLine()
      process.stderr.write(`  ${line}\n`)
    },
  }
}
