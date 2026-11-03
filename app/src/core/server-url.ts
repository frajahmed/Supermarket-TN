export class ServerUrlError extends Error {
  readonly reason: 'invalid' | 'https_required';
  constructor(reason: 'invalid' | 'https_required') {
    super(reason === 'invalid' ? 'Ungültige Server-Adresse' : 'Server-Adresse muss mit https:// beginnen');
    this.reason = reason;
  }
}

/**
 * Prüft und vereinheitlicht die Adresse des Kundenservers.
 * Architekturregel: ausschließlich HTTPS. `http://` nur in Entwicklungs-Builds (`__DEV__`).
 */
export function normalizeServerUrl(input: string, options: { allowInsecure: boolean }): string {
  const trimmed = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) throw new ServerUrlError('invalid');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ServerUrlError('invalid');
  }
  if (url.username || url.password || url.search || url.hash || !url.hostname) throw new ServerUrlError('invalid');
  if (url.protocol === 'http:' && !options.allowInsecure) throw new ServerUrlError('https_required');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ServerUrlError('invalid');
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`;
}
