export class ProviderError extends Error {
  constructor(public readonly code: string, public readonly status?: number, public readonly retryAfterSeconds?: number) {
    super(code);
  }
}

/** Bounded concurrency, response size, timeout, retry and short-lived request deduplication. */
export class JsonClient {
  private active = 0;
  private queue: (() => void)[] = [];
  private cache = new Map<string, { expires: number; promise: Promise<unknown> }>();
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 12000, private readonly ttlMs = 30000) {}
  async request(url: string, body?: unknown): Promise<unknown> {
    const key = url + (body === undefined ? '' : JSON.stringify(body));
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;
    if (this.cache.size > 200) this.cache.clear();
    const promise = this.run(url, body);
    this.cache.set(key, { expires: Date.now() + this.ttlMs, promise });
    try { return await promise; } catch (error) { this.cache.delete(key); throw error; }
  }
  private async run(url: string, body?: unknown): Promise<unknown> {
    if (this.active >= 4) await new Promise<void>(resolve => this.queue.push(resolve));
    else this.active++;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let response: Response;
        try {
          response = await this.fetcher(url, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.timeoutMs)
          });
        } catch { throw new ProviderError('PROVIDER_TIMEOUT_OR_UNAVAILABLE'); }
        if (response.status === 429) {
          const retry = Number(response.headers.get('retry-after'));
          throw new ProviderError('RATE_LIMITED', 429, Number.isFinite(retry) && retry > 0 ? retry : undefined);
        }
        if (!response.ok) {
          if (response.status >= 500 && attempt === 0) { await response.body?.cancel(); continue; }
          throw new ProviderError(response.status === 404 ? 'NOT_INDEXED' : 'PROVIDER_HTTP_ERROR', response.status);
        }
        if (Number(response.headers.get('content-length')) > 2_000_000) { await response.body?.cancel(); throw new ProviderError('RESPONSE_TOO_LARGE'); }
        const reader = response.body?.getReader();
        if (!reader) throw new ProviderError('EMPTY_RESPONSE');
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          length += item.value.length;
          if (length > 2_000_000) { await reader.cancel(); throw new ProviderError('RESPONSE_TOO_LARGE'); }
          chunks.push(item.value);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ProviderError('INVALID_PROVIDER_JSON'); }
      }
      throw new ProviderError('PROVIDER_UNAVAILABLE');
    } finally { const next = this.queue.shift(); if (next) next(); else this.active--; }
  }
}
