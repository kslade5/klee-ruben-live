// Time-zone math with the built-in Intl API (handles daylight saving correctly).

function tzOffsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asUtc - date.getTime()) / 60000;
}

// "2026-11-21T18:00" in "America/New_York" -> Date (UTC instant)
export function zonedToUtc(local, timeZone) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) throw new Error(`Bad local datetime: ${local}`);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let off = tzOffsetMinutes(new Date(guess), timeZone);
  let t = guess - off * 60000;
  const off2 = tzOffsetMinutes(new Date(t), timeZone);
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}

export function formatInZone(date, timeZone, opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(date);
}

export const icsStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
