function normalizeBasePath(basePath: string | undefined): string {
  const trimmed = (basePath ?? "/").trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

function normalizeApiBase(apiBaseUrl: string | undefined): string {
  const trimmed = (apiBaseUrl ?? "/api").trim();

  if (!trimmed) {
    return "/api";
  }

  try {
    const absoluteUrl = new URL(trimmed);
    const normalizedPath = absoluteUrl.pathname.replace(/\/+$/, "");

    absoluteUrl.pathname = !normalizedPath || normalizedPath === "/" ? "/api" : normalizedPath;
    return absoluteUrl.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function joinBasePath(basePath: string | undefined, relativePath: string): string {
  const normalizedPath = relativePath.replace(/^\/+/, "");
  return `${normalizeBasePath(basePath)}${normalizedPath}`;
}

export function joinApiBase(apiBaseUrl: string | undefined, endpoint: string): string {
  const normalizedBase = normalizeApiBase(apiBaseUrl);
  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedEndpoint}`;
}

export function publicAssetPath(relativePath: string): string {
  return joinBasePath(import.meta.env.BASE_URL, relativePath);
}

export function apiUrl(endpoint: string): string {
  return joinApiBase(import.meta.env.VITE_API_BASE_URL, endpoint);
}
