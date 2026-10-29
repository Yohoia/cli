// Compare declared versions without treating build metadata as a new release.
export function compareVersions(
  left: string,
  right: string,
): number | undefined {
  const parse = (value: string) =>
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return undefined;
  if (
    [a[4], b[4]].some((part) =>
      part?.split(".").some((id) => /^0\d+$/.test(id)),
    )
  )
    return undefined;
  const numeric = (x: string, y: string) =>
    BigInt(x) > BigInt(y) ? 1 : BigInt(x) < BigInt(y) ? -1 : 0;
  for (let index = 1; index <= 3; index++) {
    const difference = numeric(a[index]!, b[index]!);
    if (difference) return difference;
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const ap = a[4].split(".");
  const bp = b[4].split(".");
  for (let index = 0; index < Math.max(ap.length, bp.length); index++) {
    const x = ap[index];
    const y = bp[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return numeric(x, y);
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
