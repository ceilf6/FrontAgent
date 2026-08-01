/** Business days until delivery, given a distance in km. */
export function estimateEta(distanceKm: number): number {
  if (distanceKm <= 0) return 0;
  return Math.floor(distanceKm / 500) + 1;
}
