// The printed postcard text block: landmark, date, time, coordinates, number.

export const TOTAL = 10;
export const TIME_ZONE = "Europe/London";

function parts(date) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

// "2026-11-14" in London time.
export function formatDate(date) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

// "14:05" in London time.
export function formatTime(date) {
  const p = parts(date);
  return `${p.hour}:${p.minute}`;
}

// "51.50073° N, 0.12463° W", or a plain sentence when the position is unknown.
export function formatCoords(coords) {
  if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
    return "Position not known";
  }
  const lat = `${Math.abs(coords.lat).toFixed(5)}° ${coords.lat < 0 ? "S" : "N"}`;
  const lng = `${Math.abs(coords.lng).toFixed(5)}° ${coords.lng < 0 ? "W" : "E"}`;
  return `${lat}, ${lng}`;
}

export function formatNumber(number) {
  return `No. ${number} of ${TOTAL}`;
}

// Returns the lines of the postcard text block.
export function postcardLines(name, number, date, coords) {
  const when = date instanceof Date ? date : new Date(date);
  return [name, formatDate(when), formatTime(when), formatCoords(coords), formatNumber(number)];
}

// Returns the printed postcard text block as one string, one item per line.
export function postcardText(name, number, date, coords) {
  return postcardLines(name, number, date, coords).join("\n");
}

export default postcardText;
