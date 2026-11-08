// Where each ornament hangs on the virtual tree. Shared by the server (which hands out a slot when an
// ornament is hung) and the browser (which draws it). Tree coordinates: x -1..1 across the tree's full
// half-width, y 0 (bottom) to 1 (the tip, where the star sits).
export const ORN_CAP = 40; // the latest 40 ornaments are drawn

// An R2 low-discrepancy sequence: any run of slots (1, 2, 5 or 40 ornaments) is spread out evenly,
// never in a clump, and the same slot always lands in the same place.
export function ornamentSpot(slot) {
  const k = Math.max(0, slot | 0);
  const u = (0.5 + k * 0.7548776662466927) % 1;
  const v = (0.5 + k * 0.5698402909980532) % 1;
  const y = 0.13 + 0.6 * (1 - Math.sqrt(u)); // more room near the wide bottom, never near the star
  const room = (0.98 - 0.94 * y) * 0.74;     // half-width of the tree at that height, with a margin for the boughs
  return { x: (v * 2 - 1) * room, y };
}
