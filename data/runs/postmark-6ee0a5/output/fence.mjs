// The fence: ten London landmarks, the "Here" card, distance and the unlock rule.
// This is the only place the unlock rule lives.

export const FENCE_METRES = 150;
export const EARTH_RADIUS_METRES = 6371008.8;

export const LANDMARKS = Object.freeze([
  { number: 1, name: "Big Ben", lat: 51.50073, lng: -0.12463 },
  { number: 2, name: "London Eye", lat: 51.50330, lng: -0.11956 },
  { number: 3, name: "Tower Bridge", lat: 51.50546, lng: -0.07535 },
  { number: 4, name: "Tower of London", lat: 51.50810, lng: -0.07594 },
  { number: 5, name: "St Paul's Cathedral", lat: 51.51381, lng: -0.09840 },
  { number: 6, name: "Buckingham Palace", lat: 51.50136, lng: -0.14189 },
  { number: 7, name: "Trafalgar Square", lat: 51.50803, lng: -0.12807 },
  { number: 8, name: "Piccadilly Circus", lat: 51.51008, lng: -0.13470 },
  { number: 9, name: "British Museum", lat: 51.51939, lng: -0.12694 },
  { number: 10, name: "The Shard", lat: 51.50450, lng: -0.08650 },
].map(Object.freeze));

// The universal card. It has no fixed place: it unlocks wherever the member stands.
export const HERE = Object.freeze({ number: 0, name: "Here", lat: null, lng: null, anywhere: true });

export const CARDS = Object.freeze([...LANDMARKS, HERE]);

export function findCard(name) {
  return CARDS.find((c) => c.name === name) || null;
}

const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle distance in metres between two { lat, lng } points.
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Distances are compared at millimetre precision so floating-point noise
// cannot move a point that is exactly 150 m away outside the fence.
const toMillimetre = (m) => Math.round(m * 1000) / 1000;

// unlock(distanceInMetres) or unlock(card, position).
// True at 150 m or less, false beyond it. The "Here" card is always open.
export function unlock(cardOrDistance, position) {
  if (typeof cardOrDistance === "number") {
    return Number.isFinite(cardOrDistance) && toMillimetre(cardOrDistance) <= FENCE_METRES;
  }
  const card = cardOrDistance;
  if (!card) return false;
  if (card.anywhere) return true;
  if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return false;
  return unlock(haversine(card, position));
}

// Distance from a position to a card, or null for "Here" or an unknown position.
export function distanceTo(card, position) {
  if (!card || card.anywhere || !position) return null;
  return haversine(card, position);
}
