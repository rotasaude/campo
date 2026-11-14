// The box a PMTiles file covers, read from its header: the map opens framed on
// the city even on the first day, when no household has a point yet. PMTiles
// v3: 127 bytes; the box is four little-endian int32 (degrees × 10^7) at bytes
// 102–117: west, south, east, north.
export const PMTILES_HEADER_BYTES = 127;

export interface MapBounds { west: number; south: number; east: number; north: number }

const MAGIC = [0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73]; // "PMTiles"

export function pmtilesBounds(head: Uint8Array): MapBounds | null {
  if (head.length < PMTILES_HEADER_BYTES || MAGIC.some((byte, i) => head[i] !== byte) || head[7] !== 3) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const degrees = (offset: number) => view.getInt32(offset, true) / 1e7;
  const box = { west: degrees(102), south: degrees(106), east: degrees(110), north: degrees(114) };
  const inWorld = box.west >= -180 && box.east <= 180 && box.south >= -90 && box.north <= 90;
  return inWorld && box.west < box.east && box.south < box.north ? box : null;
}
