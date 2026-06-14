// Generates locally-unique, prefixed string IDs (e.g. "timeline_1718380000000042").
// Combines the current time with a rolling counter so several IDs created within
// the same millisecond don't collide.
let counter = 0;

export function genId(prefix: string): string {
  counter = (counter + 1) % 1000;
  return `${prefix}_${Date.now()}${counter.toString().padStart(3, '0')}`;
}
