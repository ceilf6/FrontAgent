export function parseQuery(query: string): Record<string, string> {
  const result: Record<string, string> = {};
  const trimmed = query.startsWith("?") ? query.slice(1) : query;
  if (!trimmed) return result;
  for (const pair of trimmed.split("&")) {
    const [key, value] = pair.split("=");
    if (key) result[key] = value ?? "";
  }
  return result;
}
