// Treemap « squarified » (Bruls, Huizing & van Wijk, 2000) : découpe un rectangle en tuiles
// d'aire proportionnelle aux valeurs, en gardant des tuiles aussi carrées que possible.
// Sert à la ville des processus (page Système) : une tuile = l'emprise au sol d'un processus.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tile<T> extends Rect {
  item: T;
}

/** Pire rapport d'aspect d'une rangée d'aires posée le long d'un côté de longueur `side`. */
function worst(row: number[], side: number): number {
  const sum = row.reduce((s, a) => s + a, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Tuiles pour `items` dans `bounds`. Les valeurs nulles ou négatives sont ignorées ; l'ordre
 * de sortie suit l'ordre décroissant des valeurs (les plus gros en premier, dans un coin).
 */
export function squarify<T>(items: T[], value: (item: T) => number, bounds: Rect): Tile<T>[] {
  const entries = items.map((item) => ({ item, v: value(item) })).filter((e) => e.v > 0 && Number.isFinite(e.v));
  const total = entries.reduce((s, e) => s + e.v, 0);
  if (total <= 0 || bounds.w <= 0 || bounds.h <= 0) return [];
  entries.sort((a, b) => b.v - a.v);
  const scale = (bounds.w * bounds.h) / total;
  const areas = entries.map((e) => e.v * scale);

  const tiles: Tile<T>[] = [];
  let free = { ...bounds };
  let start = 0;
  while (start < areas.length) {
    const side = Math.min(free.w, free.h);
    let end = start + 1;
    // On allonge la rangée tant que ça améliore (ou garde) le pire rapport d'aspect.
    while (end < areas.length && worst(areas.slice(start, end + 1), side) <= worst(areas.slice(start, end), side)) end++;

    const row = areas.slice(start, end);
    const rowArea = row.reduce((s, a) => s + a, 0);
    const horizontal = free.w >= free.h; // rangée verticale le long du côté court
    const thickness = rowArea / side;
    let offset = 0;
    row.forEach((a, i) => {
      const len = a / thickness;
      tiles.push(
        horizontal
          ? { item: entries[start + i].item, x: free.x, y: free.y + offset, w: thickness, h: len }
          : { item: entries[start + i].item, x: free.x + offset, y: free.y, w: len, h: thickness },
      );
      offset += len;
    });
    free = horizontal
      ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
      : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness };
    start = end;
  }
  return tiles;
}
