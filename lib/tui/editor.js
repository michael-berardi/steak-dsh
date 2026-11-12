/**
 * Multi-line line editor. Cursor moves by grapheme cluster; history on up/down at the edges; emacs kill keys with a
 * yank buffer; paste inserts verbatim (never interpreted); holding Backspace for 1.5 s clears the input.
 * Pure data plus `handle(event)`: no terminal I/O, so the tests drive it directly.
 */
import { fitLine, graphemeWidth, graphemes, visibleWidth } from "./width.js";

export const HOLD_DELETE_CLEAR_MS = 1500;
const HOLD_GAP_MS = 200;
const isWordChar = (g) => /[\p{L}\p{N}_]/u.test(g);

export class Editor {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.lines = [""];
    this.row = 0;
    this.col = 0; // UTF-16 offset into lines[row], always on a grapheme boundary
    this.history = [];
    this.historyIndex = -1; // -1 = editing the draft
    this.draft = "";
    this.yankBuffer = "";
    this.holdStart = undefined;
    this.lastBackspace = undefined;
  }

  get text() { return this.lines.join("\n"); }
  get empty() { return this.lines.length === 1 && this.lines[0] === ""; }

  set(text) {
    this.lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
  }

  clear() { this.set(""); this.historyIndex = -1; }

  insert(text) {
    const parts = String(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, "").split("\n");
    const line = this.lines[this.row];
    const head = line.slice(0, this.col);
    const tail = line.slice(this.col);
    if (parts.length === 1) {
      this.lines[this.row] = head + parts[0] + tail;
      this.col += parts[0].length;
    } else {
      const last = parts[parts.length - 1];
      this.lines.splice(this.row, 1, head + parts[0], ...parts.slice(1, -1), last + tail);
      this.row += parts.length - 1;
      this.col = last.length;
    }
  }

  newline() { this.insert("\n"); }

  prevBoundary(line, col) {
    let at = 0;
    for (const g of graphemes(line)) { if (at + g.length >= col) return at; at += g.length; }
    return at;
  }

  nextBoundary(line, col) {
    let at = 0;
    for (const g of graphemes(line)) { at += g.length; if (at > col) return at; }
    return line.length;
  }

  left() {
    if (this.col > 0) this.col = this.prevBoundary(this.lines[this.row], this.col);
    else if (this.row > 0) { this.row--; this.col = this.lines[this.row].length; }
  }

  right() {
    const line = this.lines[this.row];
    if (this.col < line.length) this.col = this.nextBoundary(line, this.col);
    else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; }
  }

  displayCol() { return visibleWidth(this.lines[this.row].slice(0, this.col)); }

  moveToDisplayCol(row, target) {
    let at = 0;
    let used = 0;
    for (const g of graphemes(this.lines[row])) {
      const w = graphemeWidth(g);
      if (used + w > target) break;
      used += w;
      at += g.length;
    }
    this.row = row;
    this.col = at;
  }

  up() {
    if (this.row > 0) this.moveToDisplayCol(this.row - 1, this.displayCol());
    else this.historyStep(1);
  }

  down() {
    if (this.row < this.lines.length - 1) this.moveToDisplayCol(this.row + 1, this.displayCol());
    else this.historyStep(-1);
  }

  historyStep(direction) {
    if (this.history.length === 0) return;
    if (direction > 0) {
      if (this.historyIndex + 1 >= this.history.length) return;
      if (this.historyIndex === -1) this.draft = this.text;
      this.historyIndex++;
      this.set(this.history[this.history.length - 1 - this.historyIndex]);
      this.row = 0; this.col = 0;
    } else {
      if (this.historyIndex === -1) return;
      this.historyIndex--;
      this.set(this.historyIndex === -1 ? this.draft : this.history[this.history.length - 1 - this.historyIndex]);
    }
  }

  home() { this.col = 0; }
  end() { this.col = this.lines[this.row].length; }

  wordLeft() {
    const gs = graphemes(this.lines[this.row].slice(0, this.col));
    let i = gs.length;
    while (i > 0 && !isWordChar(gs[i - 1])) i--;
    while (i > 0 && isWordChar(gs[i - 1])) i--;
    if (gs.length === 0 && this.row > 0) return this.left();
    this.col = gs.slice(0, i).join("").length;
  }

  wordRight() {
    const line = this.lines[this.row];
    const gs = graphemes(line.slice(this.col));
    let i = 0;
    while (i < gs.length && !isWordChar(gs[i])) i++;
    while (i < gs.length && isWordChar(gs[i])) i++;
    if (gs.length === 0 && this.row < this.lines.length - 1) return this.right();
    this.col += gs.slice(0, i).join("").length;
  }

  removeRange(row, from, to) {
    const line = this.lines[row];
    const removed = line.slice(from, to);
    this.lines[row] = line.slice(0, from) + line.slice(to);
    this.col = from;
    return removed;
  }

  backspace() {
    if (this.col > 0) this.removeRange(this.row, this.prevBoundary(this.lines[this.row], this.col), this.col);
    else if (this.row > 0) {
      const prev = this.lines[this.row - 1];
      this.lines.splice(this.row - 1, 2, prev + this.lines[this.row]);
      this.row--;
      this.col = prev.length;
    }
  }

  deleteForward() {
    const line = this.lines[this.row];
    if (this.col < line.length) this.removeRange(this.row, this.col, this.nextBoundary(line, this.col));
    else if (this.row < this.lines.length - 1) this.lines.splice(this.row, 2, line + this.lines[this.row + 1]);
  }

  deleteWordBack() {
    const end = this.col;
    this.wordLeft();
    if (this.col < end) this.yankBuffer = this.removeRange(this.row, this.col, end);
    else this.backspace();
  }

  killToEnd() {
    const line = this.lines[this.row];
    if (this.col < line.length) this.yankBuffer = this.removeRange(this.row, this.col, line.length);
    else if (this.row < this.lines.length - 1) { this.yankBuffer = "\n"; this.deleteForward(); }
  }

  killToStart() {
    if (this.col > 0) this.yankBuffer = this.removeRange(this.row, 0, this.col);
    else if (this.row > 0) this.backspace();
  }

  yank() { if (this.yankBuffer) this.insert(this.yankBuffer); }

  /** Hold-to-clear: repeated backspaces within 200 ms of each other for 1.5 s wipe the whole input. */
  trackBackspace() {
    const t = this.now();
    if (this.lastBackspace === undefined || t - this.lastBackspace > HOLD_GAP_MS) this.holdStart = t;
    this.lastBackspace = t;
    if (t - this.holdStart >= HOLD_DELETE_CLEAR_MS) {
      this.set("");
      this.holdStart = undefined;
      this.lastBackspace = undefined;
      return true;
    }
    return false;
  }

  submit() {
    const text = this.text;
    if (text.trim() === "") return undefined;
    if (this.history.at(-1) !== text) this.history.push(text);
    this.historyIndex = -1;
    this.draft = "";
    this.set("");
    return text;
  }

  /** Apply one key/text/paste event. Returns { submit: text } when Enter sends a message. */
  handle(event) {
    if (event.type === "paste") { this.insert(event.text); return {}; }
    if (event.type === "text") { this.insert(event.text); return {}; }
    if (event.type !== "key") return {};
    if (event.name !== "backspace") this.lastBackspace = undefined;
    const { name, ctrl, alt, shift } = event;
    if (name === "char" && event.text) { this.insert(event.text); return {}; }
    if (name === "enter") {
      if (ctrl || alt || shift) { this.newline(); return {}; }
      const line = this.lines[this.row];
      if (this.col === line.length && line.endsWith("\\")) { // a trailing backslash continues the message
        this.lines[this.row] = line.slice(0, -1);
        this.col -= 1;
        this.newline();
        return {};
      }
      const text = this.submit();
      return text === undefined ? {} : { submit: text };
    }
    if (ctrl) {
      switch (name) {
        case "a": this.home(); return {};
        case "e": this.end(); return {};
        case "b": this.left(); return {};
        case "f": this.right(); return {};
        case "w": this.deleteWordBack(); return {};
        case "u": this.killToStart(); return {};
        case "k": this.killToEnd(); return {};
        case "y": this.yank(); return {};
        case "d": if (!this.empty) this.deleteForward(); return {};
        case "h": this.backspace(); return {};
        case "p": this.up(); return {};
        case "n": this.down(); return {};
        case "left": this.wordLeft(); return {};
        case "right": this.wordRight(); return {};
        default: return {};
      }
    }
    switch (name) {
      case "backspace":
        if (alt) this.deleteWordBack();
        else if (!this.trackBackspace()) this.backspace();
        return {};
      case "delete": this.deleteForward(); return {};
      case "left": alt ? this.wordLeft() : this.left(); return {};
      case "right": alt ? this.wordRight() : this.right(); return {};
      case "up": this.up(); return {};
      case "down": this.down(); return {};
      case "home": this.home(); return {};
      case "end": this.end(); return {};
      case "b": if (alt) this.wordLeft(); return {};
      case "f": if (alt) this.wordRight(); return {};
      case "d": if (alt) { const end = this.col; this.wordRight(); this.yankBuffer = this.removeRange(this.row, end, this.col); this.col = end; } return {};
      default: return {};
    }
  }

  /**
   * Visual rows for `width` columns of text (the caller adds the gutter). Long lines hard-wrap on grapheme
   * boundaries. Returns { rows: string[], cursorRow, cursorCol }.
   */
  layout(width) {
    const w = Math.max(1, width);
    const rows = [];
    let cursorRow = 0;
    let cursorCol = 0;
    this.lines.forEach((line, lineIndex) => {
      let cur = "";
      let curW = 0;
      let offset = 0;
      let placed = false;
      const place = () => {
        if (!placed && lineIndex === this.row && this.col <= offset + cur.length && this.col >= offset) {
          cursorRow = rows.length;
          cursorCol = visibleWidth(cur.slice(0, this.col - offset));
          placed = true;
        }
      };
      for (const g of graphemes(line)) {
        const gw = graphemeWidth(g);
        if (curW + gw > w && cur !== "") {
          // The cursor at the very end of a full row belongs on the next row.
          if (!placed && lineIndex === this.row && this.col < offset + cur.length) place();
          rows.push(cur);
          offset += cur.length;
          cur = "";
          curW = 0;
        }
        cur += g;
        curW += gw;
      }
      if (!placed && lineIndex === this.row && this.col >= offset && this.col <= offset + cur.length) {
        cursorRow = rows.length;
        cursorCol = visibleWidth(cur.slice(0, this.col - offset));
      }
      rows.push(cur);
    });
    return { rows, cursorRow, cursorCol };
  }

  /** The painted composer: gutter `╰─ ` then continuation `   `, dim placeholder when empty. Window of `maxRows`. */
  render(width, theme, { maxRows = 6 } = {}) {
    const textWidth = Math.max(1, width - 3);
    const { rows, cursorRow, cursorCol } = this.layout(textWidth);
    if (this.empty) {
      return { lines: [theme.dim("╰─ ") + theme.dim(fitLine("Message", textWidth))], cursor: { row: 0, col: 3 } };
    }
    let start = 0;
    if (rows.length > maxRows) start = Math.max(0, Math.min(rows.length - maxRows, cursorRow - maxRows + 1));
    const visible = rows.slice(start, start + maxRows);
    const lines = visible.map((r, i) => (start + i === 0 ? theme.dim("╰─ ") : "   ") + r);
    return { lines, cursor: { row: cursorRow - start, col: 3 + cursorCol } };
  }
}
