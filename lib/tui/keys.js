/**
 * Terminal input decoding: bytes from stdin -> key events and paste events.
 * Bracketed paste is honoured: everything between ESC[200~ and ESC[201~ is one {type:"paste"} event and is never
 * interpreted as keys, even when a paste spans several reads. A lone ESC is the Escape key.
 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CSI_LETTERS = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift-tab" };
const CSI_TILDE = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };

function modsOf(n) {
  const bits = Math.max(0, (Number(n) || 1) - 1);
  return { shift: Boolean(bits & 1), alt: Boolean(bits & 2), ctrl: Boolean(bits & 4) };
}

export class KeyParser {
  constructor() {
    this.rest = "";
    this.paste = undefined; // accumulating text while inside a bracketed paste
  }

  /** Feed one chunk; returns the events it completes. Incomplete escape sequences wait for the next chunk. */
  feed(chunk) {
    const events = [];
    let data = this.rest + chunk;
    this.rest = "";
    for (;;) {
      if (this.paste !== undefined) {
        const end = data.indexOf(PASTE_END);
        if (end < 0) {
          // Hold back a possible partial terminator.
          let keep = 0;
          for (let n = Math.min(PASTE_END.length - 1, data.length); n > 0; n--) if (PASTE_END.startsWith(data.slice(-n))) { keep = n; break; }
          this.paste += data.slice(0, data.length - keep);
          this.rest = data.slice(data.length - keep);
          return events;
        }
        events.push({ type: "paste", text: this.paste + data.slice(0, end) });
        this.paste = undefined;
        data = data.slice(end + PASTE_END.length);
        continue;
      }
      if (data === "") return events;
      if (data.startsWith(PASTE_START)) { this.paste = ""; data = data.slice(PASTE_START.length); continue; }
      const used = this.one(data, events);
      if (used === 0) { this.rest = data; return events; }
      data = data.slice(used);
    }
  }

  /** Flush a held lone ESC (call after a short idle). */
  flush() {
    const events = [];
    if (this.rest === "\x1b") { events.push({ type: "key", name: "escape" }); this.rest = ""; }
    return events;
  }

  one(data, events) {
    const key = (name, extra = {}) => events.push({ type: "key", name, ctrl: false, alt: false, shift: false, ...extra });
    const c = data[0];
    if (c === "\x1b") {
      if (data.length === 1) return data === "\x1b" && this.rest === "" ? this.lone(events) : 0;
      if (data[1] === "[") {
        const m = /^\x1b\[([0-9;:<=>?]*)([ -/]*)([@-~])/.exec(data);
        if (!m) return /^\x1b\[[0-9;:<=>?]*[ -/]*$/.test(data) ? 0 : (key("escape"), 1);
        const [whole, params, , final] = m;
        const [first, second] = params.split(";");
        if (final === "~") key(CSI_TILDE[first] ?? `csi-${first}~`, modsOf(second));
        else if (final === "u") { // kitty-style: codepoint;mods
          const cp = Number(first);
          key(cp === 13 ? "enter" : cp === 27 ? "escape" : cp === 127 ? "backspace" : cp === 9 ? "tab" : "char", { ...modsOf(second), text: cp > 31 && cp !== 127 ? String.fromCodePoint(cp) : undefined });
        } else key(CSI_LETTERS[final] ?? `csi-${final}`, modsOf(second));
        return whole.length;
      }
      if (data[1] === "O") {
        if (data.length < 3) return 0;
        key(CSI_LETTERS[data[2]] ?? `ss3-${data[2]}`);
        return 3;
      }
      // ESC + printable: alt+<char> (alt+b, alt+f, alt+d).
      if (data[1] >= " " && data[1] !== "\x7f") {
        const cp = String.fromCodePoint(data.codePointAt(1));
        key(cp, { alt: true });
        return 1 + cp.length;
      }
      // ESC + control: alt-enter, alt-backspace ...
      const inner = [];
      const used = this.one(data.slice(1), inner);
      if (used === 0) return 0;
      for (const e of inner) events.push(e.type === "key" ? { ...e, alt: true } : e);
      return 1 + used;
    }
    if (c === "\r") { key("enter"); return data[1] === "\n" ? 2 : 1; }
    if (c === "\n") { key("enter", { ctrl: true, newline: true }); return 1; }
    if (c === "\t") { key("tab"); return 1; }
    if (c === "\x7f" || c === "\b") { key("backspace"); return 1; }
    if (c < " ") { key(String.fromCharCode(c.charCodeAt(0) + 96), { ctrl: true }); return 1; }
    // Printable run: take the text up to the next control/escape so typing is one event per read, not per char.
    let end = 1;
    while (end < data.length && data[end] >= " " && data[end] !== "\x7f") end++;
    // Never split a surrogate pair or cluster across reads: if the run ends in a lone high surrogate, wait.
    if (/[\ud800-\udbff]$/.test(data.slice(0, end))) return end === data.length ? 0 : end;
    events.push({ type: "text", text: data.slice(0, end) });
    return end;
  }

  lone(events) {
    // A lone ESC in the buffer: report as Escape immediately. Callers feeding real terminals get it as its own read.
    events.push({ type: "key", name: "escape", ctrl: false, alt: false, shift: false });
    return 1;
  }
}
