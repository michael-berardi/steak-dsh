/**
 * Minimal SemVer for the engines.dsh admission check. Node built-ins only; no dependency.
 * Supports the comparator forms used in engines ranges: >=, >, <=, <, =, bare exact, and `||` alternatives.
 * Prerelease rule (semver.org): a prerelease version satisfies a range only when some comparator in the
 * satisfied alternative carries a prerelease on the same major.minor.patch tuple.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text) {
  const match = VERSION.exec(String(text ?? "").trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? null : match[4].split("."),
  };
}

function comparePre(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // release > prerelease
  if (b === null) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort before alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

function satisfiesComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator.trim());
  if (!match) return false;
  const target = parseVersion(match[2]);
  if (!target) return false;
  const op = match[1] ?? "=";
  const cmp = compareVersions(version, target);
  switch (op) {
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    default: return cmp === 0;
  }
}

/** True when `version` satisfies `range`. Unparseable input is never satisfied (the caller warns). */
export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed || typeof range !== "string" || !range.trim()) return false;
  return range.split("||").some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    if (!comparators.every((c) => satisfiesComparator(parsed, c))) return false;
    if (parsed.pre === null) return true;
    return comparators.some((c) => {
      const target = parseVersion(c.replace(/^(>=|<=|>|<|=)/, ""));
      return target?.pre != null && target.major === parsed.major && target.minor === parsed.minor && target.patch === parsed.patch;
    });
  });
}
