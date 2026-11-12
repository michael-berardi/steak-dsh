/**
 * Theme: the Steak dark tokens. Colour is truecolor, 256-colour or none. NO_COLOR and a non-TTY output mean
 * none: every painter returns its text unchanged, so a captured frame is plain text.
 */

export const STEAK_DARK = {
  vars: {
    steakRed: "#e63946", steakDeep: "#b02a37", stem: "#2a9d5c", stemSoft: "#1f7a46",
    neutral: 245, neutralDim: 240, surface: "#16181d", surfaceRaised: "#1d2026", jackpot: "#f4c95d",
  },
  colors: {
    accent: "steakRed", success: "stem", error: "steakDeep", warning: "jackpot", muted: "neutral", text: "neutral",
    dim: 240, thinkingText: "neutralDim", userMessageBg: "surfaceRaised", toolPendingBg: "surfaceRaised",
    selectedBg: "surfaceRaised", toolSuccessBg: "surface", toolErrorBg: "surface", toolTitle: "steakRed",
    toolDiffAdded: "stem", toolDiffRemoved: "steakDeep", toolDiffContext: "neutralDim", mdHeading: "jackpot",
    mdLink: "steakRed", mdCode: "stem", mdListBullet: "steakRed",
  },
};

function resolve(token, theme) {
  let value = theme.colors[token];
  while (typeof value === "string" && !value.startsWith("#") && value in theme.vars) value = theme.vars[value];
  return value;
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Nearest xterm-256 index for an RGB triple (colour cube or grey ramp). */
export function rgbTo256([r, g, b]) {
  const level = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const cube = [r, g, b].map(level);
  const cubeIndex = 16 + 36 * cube[0] + 6 * cube[1] + cube[2];
  const cubeRgb = cube.map((l) => (l === 0 ? 0 : 55 + 40 * l));
  const grey = Math.round(((r + g + b) / 3 - 8) / 10);
  const greyIndex = 232 + Math.max(0, Math.min(23, grey));
  const greyLevel = 8 + 10 * Math.max(0, Math.min(23, grey));
  const dist = (a) => (r - a[0]) ** 2 + (g - a[1]) ** 2 + (b - a[2]) ** 2;
  return dist([greyLevel, greyLevel, greyLevel]) < dist(cubeRgb) ? greyIndex : cubeIndex;
}

/** The colour mode for an output stream and environment: "truecolor" | "256" | "none". */
export function detectColorMode(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  if (!stream?.isTTY) return "none";
  if (env.TERM === "dumb") return "none";
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return "truecolor";
  return "256";
}

/** Build a theme: `fg(token, text)`, `bg(token, text)`, `bold`, `inverse`, `strike`, `underline` and helpers. */
export function createTheme({ mode = "none", palette = STEAK_DARK } = {}) {
  const color = mode !== "none";
  const sgr = (open, close) => (text) => (color && text !== "" ? `\x1b[${open}m${text}\x1b[${close}m` : text);
  const code = (token, layer) => {
    const value = resolve(token, palette);
    if (value === undefined) return undefined;
    if (typeof value === "number") return `${layer ? 48 : 38};5;${value}`;
    if (mode === "truecolor") return `${layer ? 48 : 38};2;${hexToRgb(value).join(";")}`;
    return `${layer ? 48 : 38};5;${rgbTo256(hexToRgb(value))}`;
  };
  const fg = (token, text) => {
    const open = color ? code(token, 0) : undefined;
    return open && text !== "" ? `\x1b[${open}m${text}\x1b[39m` : text;
  };
  const bg = (token, text) => {
    const open = color ? code(token, 1) : undefined;
    return open && text !== "" ? `\x1b[${open}m${text}\x1b[49m` : text;
  };
  const theme = {
    mode, color, fg, bg,
    bold: sgr("1", "22"), inverse: sgr("7", "27"), strike: sgr("9", "29"), underline: sgr("4", "24"), italic: sgr("3", "23"),
    // Semantic painters, the same set the Steak Pi band asks its theme for.
    accent: (t) => fg("accent", t), text: (t) => fg("text", t), muted: (t) => fg("muted", t), dim: (t) => fg("dim", t),
    success: (t) => fg("success", t), warning: (t) => fg("warning", t), error: (t) => fg("error", t),
  };
  return theme;
}

/** Paint the tone names the status vocabulary uses. */
export function toneFor(theme, tone) {
  return { dim: theme.dim, accent: theme.accent, success: theme.success, warning: theme.warning, error: theme.error }[tone] ?? theme.text;
}
