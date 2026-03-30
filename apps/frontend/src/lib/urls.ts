function normalizeBasePath(basePath: string | undefined): string {
  const trimmed = (basePath ?? "/").trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function joinBasePath(basePath: string | undefined, relativePath: string): string {
  const normalizedPath = relativePath.replace(/^\/+/, "");
  return `${normalizeBasePath(basePath)}${normalizedPath}`;
}

export function joinApiBase(apiBaseUrl: string | undefined, endpoint: string): string {
  const normalizedBase = (apiBaseUrl ?? "/api").trim().replace(/\/+$/, "");
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedEndpoint}`;
}

export function publicAssetPath(relativePath: string): string {
  return joinBasePath(import.meta.env.BASE_URL, relativePath);
}

export function apiUrl(endpoint: string): string {
  return joinApiBase(import.meta.env.VITE_API_BASE_URL, endpoint);
}
