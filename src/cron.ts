// Minimal 5-field cron matcher (UTC), matching GitHub Actions `schedule` syntax:
//   minute hour day-of-month month day-of-week
// Supports *, */n, a-b, a-b/n, and comma lists. Day-of-week is 0-7 (0 and 7 =
// Sunday). When both day-of-month and day-of-week are restricted, a match on
// EITHER fires (Vixie-cron semantics).

function parseField(spec: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      step = Number.parseInt(part.slice(slash + 1), 10) || 1;
      range = part.slice(0, slash);
    }
    let start = lo;
    let end = hi;
    if (range === "*" || range === "") {
      // full range
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      start = Number.parseInt(a, 10);
      end = Number.parseInt(b, 10);
    } else {
      start = Number.parseInt(range, 10);
      end = start;
    }
    if (Number.isNaN(start) || Number.isNaN(end) || step < 1) continue;
    for (let v = start; v <= end; v += step) {
      if (v >= lo && v <= hi) out.add(v);
    }
  }
  return out;
}

function normalizeDow(set: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const v of set) out.add(v === 7 ? 0 : v);
  return out;
}

export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hr, dom, mon, dow] = parts;

  if (!parseField(min, 0, 59).has(date.getUTCMinutes())) return false;
  if (!parseField(hr, 0, 23).has(date.getUTCHours())) return false;
  if (!parseField(mon, 1, 12).has(date.getUTCMonth() + 1)) return false;

  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const domMatch = parseField(dom, 1, 31).has(date.getUTCDate());
  const dowMatch = normalizeDow(parseField(dow, 0, 7)).has(date.getUTCDay());

  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  if (domRestricted) return domMatch;
  if (dowRestricted) return dowMatch;
  return true;
}
