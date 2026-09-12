import { config } from '../config';

export interface HubPackage {
  technicalName: string;
  displayName: string;
  version: string;
  type: string | null;
  subType: string | null;
  vendor: string | null;
  shortText: string | null;
  modifiedAt: string | null;
}

export interface HubArtifact {
  name: string;
  displayName: string;
  type: string;
  subType: string | null;
  version: string;
  regId: string | null;
  description: string | null;
  modifiedAt: string | null;
}

/** Thrown when the Hub answers with its XSUAA login redirect instead of data. */
export class HubAuthRequiredError extends Error {
  constructor(url: string) {
    super(
      `SAP Business Accelerator Hub requires a session for ${url}. ` +
        `Set HUB_API_KEY or HUB_COOKIE in .env, or import the specification file manually.`
    );
    this.name = 'HubAuthRequiredError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'sap-bah-sandbox/1.0',
  };
  if (config.hub.apiKey) h['APIKey'] = config.hub.apiKey;
  if (config.hub.cookie) h['Cookie'] = config.hub.cookie;
  return h;
}

/**
 * The Hub answers unauthenticated requests with HTTP 200 and an HTML page that
 * redirects to XSUAA, so a status check alone is not enough.
 */
function isLoginRedirect(contentType: string, body: string): boolean {
  return contentType.includes('text/html') && body.includes('oauth/authorize');
}

async function hubGet(url: string, accept = 'application/json'): Promise<{ body: string; contentType: string }> {
  const res = await fetch(url, { headers: { ...authHeaders(), Accept: accept }, redirect: 'follow' });
  const contentType = res.headers.get('content-type') ?? '';
  const body = await res.text();

  if (isLoginRedirect(contentType, body)) throw new HubAuthRequiredError(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);

  return { body, contentType };
}

async function hubGetJson(url: string): Promise<any> {
  const { body } = await hubGet(url);
  return JSON.parse(body);
}

/** `/Date(1691509862373)/` -> ISO 8601. Other shapes pass through. */
export function odataDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^\/Date\((-?\d+)([+-]\d+)?\)\/$/.exec(value);
  if (m) return new Date(Number(m[1])).toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function esc(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Walks the whole package catalog. Anonymous access is enough here, which is
 * why change tracking works without any credentials.
 *
 * The filter is applied here rather than in the query: this endpoint accepts a
 * `$filter` and then silently ignores it, returning the full catalog. Paging
 * everything and matching locally is ~10 requests and is actually correct; the
 * saving that matters is downstream, where only matching packages have their
 * artifacts fetched.
 */
export async function listPackages(opts: { filter?: string; pageSize?: number } = {}): Promise<HubPackage[]> {
  const pageSize = opts.pageSize ?? 200;
  const filter = (opts.filter ?? config.hub.filter).trim().toLowerCase();
  const out: HubPackage[] = [];
  let skip = 0;

  for (;;) {
    // Built by hand rather than with URLSearchParams: that encodes spaces as
    // "+", which SAP's OData parser rejects with HTTP 400.
    const url =
      `${config.hub.base}/ContentEntities.ContentPackages` +
      `?$format=json&$top=${pageSize}&$skip=${skip}&$orderby=TechnicalName`;

    const json = await hubGetJson(url);
    const rows: any[] = json?.d?.results ?? [];

    for (const r of rows) {
      const pkg: HubPackage = {
        technicalName: r.TechnicalName,
        displayName: r.DisplayName ?? r.TechnicalName,
        version: r.Version ?? '',
        type: r.Type ?? null,
        subType: r.SubType ?? null,
        vendor: r.Vendor ?? r.OrgName ?? null,
        shortText: r.ShortText ?? null,
        modifiedAt: odataDate(r.ModifiedAt) ?? odataDate(r.PublishedAt),
      };

      if (
        !filter ||
        pkg.displayName.toLowerCase().includes(filter) ||
        pkg.technicalName.toLowerCase().includes(filter)
      ) {
        out.push(pkg);
      }
    }

    if (rows.length < pageSize) break;
    skip += pageSize;
    if (config.hub.requestDelayMs) await sleep(config.hub.requestDelayMs);
  }

  return out;
}

export async function countPackages(): Promise<number> {
  const { body } = await hubGet(`${config.hub.base}/ContentEntities.ContentPackages/$count`, 'text/plain');
  return Number(body.trim()) || 0;
}

export async function listArtifacts(packageTechnicalName: string): Promise<HubArtifact[]> {
  const url = `${config.hub.base}/ContentEntities.ContentPackages('${esc(
    packageTechnicalName
  )}')/Artifacts?$format=json`;

  const json = await hubGetJson(url);
  const rows: any[] = json?.d?.results ?? [];

  return rows.map((r) => ({
    name: r.Name,
    displayName: r.DisplayName ?? r.Name,
    type: r.Type ?? 'Unknown',
    subType: r.SubType ?? null,
    version: r.Version ?? '',
    regId: r.reg_id ?? null,
    description: r.Description ?? null,
    modifiedAt: odataDate(r.ModifiedAt) ?? odataDate(r.CreatedAt),
  }));
}

/**
 * Downloads the specification body for an artifact.
 *
 * Unlike the catalog, this endpoint is gated: without HUB_API_KEY or
 * HUB_COOKIE the Hub returns its login page and this throws
 * HubAuthRequiredError. Callers treat that as "skip, import manually".
 */
export async function fetchArtifactSpec(
  name: string,
  type: string
): Promise<{ body: string; contentType: string }> {
  const url = `${config.hub.base}/Artifacts(Name='${esc(name)}',Type='${esc(type)}')/$value`;
  return hubGet(url, '*/*');
}

export function hubUiUrl(packageName: string, artifactName?: string): string {
  return artifactName
    ? `https://api.sap.com/api/${encodeURIComponent(artifactName)}/overview`
    : `https://api.sap.com/package/${encodeURIComponent(packageName)}`;
}
