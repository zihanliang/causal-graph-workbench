function normalizeBasePath(basePath: string | undefined): string {
  const trimmed = (basePath ?? "/").trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

export function joinBasePath(basePath: string | undefined, relativePath: string): string {
  const normalizedPath = relativePath.replace(/^\/+/, "");
  return `${normalizeBasePath(basePath)}${normalizedPath}`;
}

export function publicAssetPath(relativePath: string): string {
  return joinBasePath(import.meta.env.BASE_URL, relativePath);
}
