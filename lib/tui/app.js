/**
 * Terminal I/O: raw mode, alternate screen, bracketed paste, repaint scheduling, resize, spinner timer,
 * key routing. All layout lives in screen.js; this module only moves bytes. A non-TTY stdout gets the plain
 * line mode (no escape sequences at all, see runPlain).
 */
import { Editor } from "./editor.js";
import { KeyParser } from "./keys.js";
import { composeFrame, SPINNER_MS } from "./screen.js";
import { renderBand } from "./band.js";
import { blockLines } from "./transcript.js";
import { stripAnsi } from "./width.js";

const ENTER_SCREEN = "\x1b[?1049h\x1b[?2004h\x1b[2J";
const LEAVE_SCREEN = "\x1b[?2004l\x1b[?25h\x1b[?1049l";
// Main-screen mode (a host that shows its own view asks for it): same terminal setup, no alternate screen.
const ENTER_MAIN = "\x1b[?2004h\x1b[2J";
const LEAVE_MAIN = "\x1b[?2004l\x1b[?25h";

export class TerminalApp {
  constructor({ controller, stdin, stdout, theme, now = () => Date.now(), mainScreen = false }) {
    this.mainScreen = mainScreen;
    this.c = controller;
    this.stdin = stdin;
    this.stdout = stdout;
    this.theme = theme;
    this.editor = new Editor({ now });
    this.ui = { editor: this.editor, scroll: 0, spinner: 0 };
    this.parser = new KeyParser();
    this.last = [];
    this.timer = undefined;
    this.scheduled = false;
    this.finished = undefined;
    this.restored = false;
  }

  size() {
    return { columns: this.stdout.columns || 80, rows: this.stdout.rows || 24 };
  }

  /** Run until the user quits. Resolves with the exit code. */
  run() {
    return new Promise((resolve) => {
      this.finished = resolve;
      this.c.onChange = () => this.schedule();
      this.stdin.setRawMode?.(true);
      this.stdin.setEncoding?.("utf8");
      this.stdin.resume?.();
      this.stdout.write(this.mainScreen ? ENTER_MAIN : ENTER_SCREEN);
      this.onData = (chunk) => this.onInput(String(chunk));
      this.onResize = () => { this.last = []; this.stdout.write("\x1b[2J"); this.schedule(); };
      this.onExit = () => this.restore();
      this.stdin.on("data", this.onData);
      this.stdout.on("resize", this.onResize);
      process.once("exit", this.onExit);
      this.paint();
      this.c.start().then(() => this.schedule());
    });
  }

  restore() {
    if (this.restored) return;
    this.restored = true;
    clearInterval(this.timer);
    try { this.stdin.setRawMode?.(false); } catch { /* not a TTY */ }
    this.stdin.removeListener?.("data", this.onData);
    this.stdout.removeListener?.("resize", this.onResize);
    process.removeListener("exit", this.onExit);
    // Main screen: leave the cursor on a fresh line below the last frame row.
    this.stdout.write(this.mainScreen ? `${LEAVE_MAIN}\x1b[${Math.max(1, this.last.length)};1H\r\n` : LEAVE_SCREEN);
    this.stdin.pause?.();
  }

  async quit(code = 0) {
    if (this.quitting) return;
    this.quitting = true;
    this.c.dispatch({ type: "footer", text: "shutting down…" });
    this.paint();
    await this.c.quit();
    this.restore();
    this.finished?.(code);
  }

  schedule() {
    this.syncTimer();
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; if (!this.restored) this.paint(); });
  }

  syncTimer() {
    const wants = this.c.state.busy && !this.c.state.prompt;
    if (wants && !this.timer) {
      this.timer = setInterval(() => { this.ui.spinner++; this.paint(); }, SPINNER_MS);
      this.timer.unref?.();
    } else if (!wants && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  paint() {
    if (this.restored) return;
    const frame = composeFrame(this.c.state, this.ui, this.size(), this.theme);
    let out = "\x1b[?2026h\x1b[?25l";
    frame.lines.forEach((line, i) => {
      if (this.last[i] !== line) out += `\x1b[${i + 1};1H${line}\x1b[0m\x1b[K`;
    });
    for (let i = frame.lines.length; i < this.last.length; i++) out += `\x1b[${i + 1};1H\x1b[K`;
    if (frame.cursor) out += `\x1b[${frame.cursor.row + 1};${frame.cursor.col + 1}H\x1b[?25h`;
    out += "\x1b[?2026l";
    this.last = frame.lines;
    this.stdout.write(out);
  }

  onInput(chunk) {
    for (const event of this.parser.feed(chunk)) this.route(event);
    this.schedule();
  }

  route(event) {
    const c = this.c;
    if (c.promptEvent(event)) return;
    if (event.type === "key") {
      const { name, ctrl } = event;
      if (ctrl && name === "c") {
        if (c.state.busy) void c.cancel();
        else if (!this.editor.empty) this.editor.clear();
        else void this.quit();
        return;
      }
      if (name === "escape") { if (c.state.busy) void c.cancel(); return; }
      if (ctrl && name === "d" && this.editor.empty) { void this.quit(); return; }
      if (ctrl && name === "o") return c.dispatch({ type: "toggleTools" });
      if (ctrl && name === "t") return c.dispatch({ type: "toggleThinking" });
      if (ctrl && name === "l") { this.last = []; this.stdout.write("\x1b[2J"); return; }
      if (name === "pageup") { this.ui.scroll += Math.max(1, this.size().rows - 6); return; }
      if (name === "pagedown") { this.ui.scroll = Math.max(0, this.ui.scroll - Math.max(1, this.size().rows - 6)); return; }
      if (ctrl && name === "end") { this.ui.scroll = 0; return; }
    }
    const result = this.editor.handle(event);
    if (result.submit !== undefined) {
      this.ui.scroll = 0;
      void c.submit(result.submit).then((r) => { if (r?.quit) return this.quit(); });
    }
  }
}

/**
 * Plain line mode for a non-TTY output (a pipe, a file, CI): no escape sequences, no raw mode.
 * Each stdin line is sent as one message; finished transcript blocks print once; a band line prints when the
 * agent settles. EOF waits for the running turn, then quits.
 */
export async function runPlain({ controller, stdin, stdout, theme, width = 80 }) {
  const c = controller;
  let printed = 0;
  const idleWaiters = [];
  const flush = () => {
    const blocks = c.state.blocks;
    while (printed < blocks.length) {
      const block = blocks[printed];
      if (block.kind === "tool" && block.status === "pending") break;
      for (const line of blockLines(block, width, c.state, theme)) stdout.write(stripAnsi(line).replace(/\s+$/, "") + "\n");
      printed += 1;
    }
    if (!c.state.busy && !c.state.prompt) {
      while (idleWaiters.length) idleWaiters.shift()();
    }
  };
  c.onChange = flush;
  await c.start();
  stdout.write(stripAnsi(renderBand(width, c.state, theme).join("\n")) + "\n");
  const idle = () => new Promise((resolve) => { if (!c.state.busy && !c.state.prompt) resolve(); else idleWaiters.push(resolve); });
  let buffer = "";
  const lines = [];
  let ended = false;
  let wake;
  stdin.setEncoding?.("utf8");
  stdin.on("data", (d) => { buffer += d; let n; while ((n = buffer.indexOf("\n")) >= 0) { lines.push(buffer.slice(0, n)); buffer = buffer.slice(n + 1); } wake?.(); });
  stdin.on("end", () => { if (buffer.trim()) lines.push(buffer); buffer = ""; ended = true; wake?.(); });
  for (;;) {
    while (lines.length === 0 && !ended) await new Promise((r) => { wake = r; });
    if (lines.length === 0 && ended) break;
    const line = lines.shift();
    if (line.trim() === "") continue;
    // Approvals cannot be answered without a terminal: fail closed.
    const result = await c.submit(line);
    if (result?.quit) break;
    await new Promise((r) => setTimeout(r, 0));
    c.onChange = flush;
    // Refuse any approval that arrives while no human is attached to a TTY.
    const refuse = setInterval(() => { if (c.state.prompt) c.promptEvent({ type: "key", name: "escape" }); }, 20);
    await idle();
    clearInterval(refuse);
    flush();
    stdout.write(stripAnsi(renderBand(width, c.state, theme).join("\n")) + "\n");
  }
  await c.quit();
  return 0;
}
