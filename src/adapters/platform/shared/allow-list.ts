export function parseAllowList(value?: string): Set<string> | null {
  if (!value || value.trim() === "*") {
    return null;
  }
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new Set(list);
}
