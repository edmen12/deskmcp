import {
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens
} from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import type { SecretStore } from './secure-secret-store.js';

interface PersistedOAuthState {
  readonly version: 1;
  readonly clients: Record<string, StoredOAuthClientInformation>;
  readonly tokens?: StoredOAuthTokens;
  readonly code_verifier?: string;
  readonly discovery?: OAuthDiscoveryState;
  readonly authorization_server_url?: string;
  readonly resource_url?: string;
}

export interface OAuthPublicStatus {
  readonly configured: true;
  readonly authenticated: boolean;
  readonly scope?: string;
  readonly issuer?: string;
}

/**
 * Credentials for an OAuth client that was registered with an authorization
 * server out of band. The secret is supplied at runtime only and is never
 * persisted by this provider.
 */
export interface StaticOAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post' | 'none';
}

function emptyState(): PersistedOAuthState {
  return { version: 1, clients: {} };
}

function parseState(raw: string | undefined): PersistedOAuthState {
  if (!raw) return emptyState();
  const parsed = JSON.parse(raw) as Partial<PersistedOAuthState>;
  if (parsed.version !== 1 || !parsed.clients || typeof parsed.clients !== 'object' || Array.isArray(parsed.clients)) {
    throw new Error('Stored Dynamic MCP OAuth state is invalid.');
  }
  return {
    version: 1,
    clients: { ...parsed.clients },
    ...(parsed.tokens ? { tokens: parsed.tokens } : {}),
    ...(typeof parsed.code_verifier === 'string' ? { code_verifier: parsed.code_verifier } : {}),
    ...(parsed.discovery ? { discovery: parsed.discovery } : {}),
    ...(typeof parsed.authorization_server_url === 'string'
      ? { authorization_server_url: parsed.authorization_server_url }
      : {}),
    ...(typeof parsed.resource_url === 'string' ? { resource_url: parsed.resource_url } : {})
  };
}

function tokenIssuer(tokens: StoredOAuthTokens | undefined): string | undefined {
  if (!tokens || typeof tokens !== 'object') return undefined;
  const issuer = (tokens as StoredOAuthTokens & { issuer?: unknown }).issuer;
  return typeof issuer === 'string' ? issuer : undefined;
}

function resourceIdentity(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, '');
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function sameResource(left: string, right: string): boolean {
  const leftIdentity = resourceIdentity(left);
  const rightIdentity = resourceIdentity(right);
  return leftIdentity !== undefined && leftIdentity === rightIdentity;
}

export class DeskMcpOAuthProvider implements OAuthClientProvider {
  private stateValue: PersistedOAuthState = emptyState();
  private loaded = false;
  private lastStateValue: string | undefined;
  private authorizationUrlValue: URL | undefined;

  constructor(
    private readonly storageKey: string,
    private readonly store: SecretStore,
    readonly redirectUrl: string,
    private readonly requestedScope?: string,
    private readonly onRedirect?: (url: URL) => void | Promise<void>,
    private readonly staticClient?: StaticOAuthClientCredentials,
    private readonly expectedResourceUrl?: string
  ) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    const current = parseState(await this.store.get(this.storageKey));
    if (!current.tokens) {
      let legacy: PersistedOAuthState | undefined;
      let removeLegacy: (() => Promise<void>) | undefined;

      if (this.store.getLegacy) {
        const legacyRaw = await this.store.getLegacy(this.storageKey);
        if (legacyRaw) {
          const candidate = parseState(legacyRaw);
          const resourceMatches = !this.expectedResourceUrl
            || !candidate.resource_url
            || sameResource(candidate.resource_url, this.expectedResourceUrl);
          if (candidate.tokens && resourceMatches) {
            legacy = candidate;
            if (this.store.deleteLegacy) {
              removeLegacy = () => this.store.deleteLegacy!(this.storageKey);
            }
          }
        }
      }

      if (!legacy && this.expectedResourceUrl && this.store.listLegacyCandidates) {
        const matches: Array<{ id: string; state: PersistedOAuthState }> = [];
        for (const candidate of await this.store.listLegacyCandidates()) {
          try {
            const state = parseState(candidate.value);
            if (!state.tokens) continue;
            const resourceMatches = Boolean(
              state.resource_url && sameResource(state.resource_url, this.expectedResourceUrl)
            );
            const authorizationServerMatches = Boolean(
              current.authorization_server_url
              && state.authorization_server_url
              && sameResource(state.authorization_server_url, current.authorization_server_url)
            );
            if (resourceMatches || authorizationServerMatches) {
              matches.push({ id: candidate.id, state });
            }
          } catch {
            // Legacy candidate discovery is best-effort; malformed unrelated entries are ignored.
          }
        }
        if (matches.length > 1) {
          throw new Error('Multiple legacy OAuth secrets match this Dynamic MCP resource; refusing ambiguous credential migration.');
        }
        const match = matches[0];
        if (match) {
          legacy = match.state;
          if (this.store.deleteLegacyCandidate) {
            removeLegacy = () => this.store.deleteLegacyCandidate!(match.id);
          }
        }
      }

      if (legacy?.tokens) {
        this.stateValue = {
          ...legacy,
          ...(current.discovery ? { discovery: current.discovery } : {}),
          ...(current.authorization_server_url
            ? { authorization_server_url: current.authorization_server_url }
            : {}),
          ...(current.resource_url ? { resource_url: current.resource_url } : {}),
          ...(current.code_verifier ? { code_verifier: current.code_verifier } : {})
        };
        await this.store.set(this.storageKey, JSON.stringify(this.stateValue));
        await removeLegacy?.().catch(() => undefined);
        this.loaded = true;
        return;
      }
    }
    this.stateValue = current;
    this.loaded = true;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'DeskMCP',
      client_uri: 'https://github.com/edmen12/deskmcp',
      redirect_uris: [this.redirectUrl],
      application_type: 'native',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.requestedScope ? { scope: this.requestedScope } : {})
    };
  }

  get authorizationUrl(): URL | undefined {
    return this.authorizationUrlValue ? new URL(this.authorizationUrlValue) : undefined;
  }

  get expectedState(): string | undefined {
    return this.lastStateValue;
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    await this.init();
    if (this.staticClient) {
      return {
        client_id: this.staticClient.clientId,
        ...(this.staticClient.clientSecret ? { client_secret: this.staticClient.clientSecret } : {}),
        token_endpoint_auth_method: this.staticClient.tokenEndpointAuthMethod,
        ...(ctx ? { issuer: ctx.issuer } : {})
      };
    }
    if (!ctx) return undefined;
    return this.stateValue.clients[ctx.issuer];
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext
  ): Promise<void> {
    await this.init();
    // A static client is configured by the registry and may include a secret
    // read from an environment variable. Never persist that secret in the
    // OAuth state, even if an SDK caller attempts to save it.
    if (this.staticClient) return;
    if (!ctx?.issuer) throw new Error('OAuth client registration is missing its authorization-server issuer binding.');
    this.stateValue = {
      ...this.stateValue,
      clients: {
        ...this.stateValue.clients,
        [ctx.issuer]: clientInformation
      }
    };
    await this.persist();
  }

  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    await this.init();
    const tokens = this.stateValue.tokens;
    if (!ctx) return tokens;
    const issuer = tokenIssuer(tokens);
    return issuer === ctx.issuer ? tokens : undefined;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.init();
    this.stateValue = { ...this.stateValue, tokens };
    await this.persist();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const redirectUrl = new URL(authorizationUrl);
    const scope = this.authorizationScope(redirectUrl);
    if (scope) redirectUrl.searchParams.set('scope', scope);
    this.authorizationUrlValue = redirectUrl;
    await this.onRedirect?.(new URL(redirectUrl));
  }

  state(): string {
    this.lastStateValue = randomUUID();
    return this.lastStateValue;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.init();
    this.stateValue = { ...this.stateValue, code_verifier: codeVerifier };
    await this.persist();
  }

  async codeVerifier(): Promise<string> {
    await this.init();
    const verifier = this.stateValue.code_verifier;
    if (!verifier) throw new Error('OAuth PKCE code verifier is unavailable.');
    return verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.init();
    this.stateValue = { ...this.stateValue, discovery };
    await this.persist();
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    await this.init();
    return this.stateValue.discovery;
  }

  async saveAuthorizationServerUrl(authorizationServerUrl: string): Promise<void> {
    await this.init();
    this.stateValue = { ...this.stateValue, authorization_server_url: authorizationServerUrl };
    await this.persist();
  }

  async authorizationServerUrl(): Promise<string | undefined> {
    await this.init();
    return this.stateValue.authorization_server_url;
  }

  async saveResourceUrl(resourceUrl: string): Promise<void> {
    await this.init();
    this.stateValue = { ...this.stateValue, resource_url: resourceUrl };
    await this.persist();
  }

  async resourceUrl(): Promise<string | undefined> {
    await this.init();
    return this.stateValue.resource_url;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await this.init();
    if (scope === 'all') {
      this.stateValue = emptyState();
      this.lastStateValue = undefined;
      this.authorizationUrlValue = undefined;
      await this.store.delete(this.storageKey);
      return;
    }
    if (scope === 'client') this.stateValue = { ...this.stateValue, clients: {} };
    if (scope === 'tokens') {
      const { tokens: _tokens, ...rest } = this.stateValue;
      this.stateValue = rest;
    }
    if (scope === 'verifier') {
      const { code_verifier: _verifier, ...rest } = this.stateValue;
      this.stateValue = rest;
    }
    if (scope === 'discovery') {
      const {
        discovery: _discovery,
        authorization_server_url: _authorizationServerUrl,
        resource_url: _resourceUrl,
        ...rest
      } = this.stateValue;
      this.stateValue = rest;
    }
    await this.persist();
  }

  async publicStatus(): Promise<OAuthPublicStatus> {
    await this.init();
    const tokens = this.stateValue.tokens;
    const scope = tokens && typeof (tokens as { scope?: unknown }).scope === 'string'
      ? (tokens as { scope: string }).scope
      : undefined;
    const issuer = tokenIssuer(tokens);
    return {
      configured: true,
      authenticated: Boolean(tokens),
      ...(scope ? { scope } : {}),
      ...(issuer ? { issuer } : {})
    };
  }

  private async persist(): Promise<void> {
    await this.store.set(this.storageKey, JSON.stringify(this.stateValue));
  }

  /**
   * Resource metadata can advertise a broad set of available scopes. Some
   * OAuth transports pass that list as an explicit request, which takes
   * precedence over client metadata in the SDK. Enforce the scope selected in
   * the DeskMCP registry at the final redirect boundary. Keep offline_access
   * only when the authorization server already requested it, so refresh-token
   * support is not accidentally disabled.
   */
  private authorizationScope(authorizationUrl: URL): string | undefined {
    if (!this.requestedScope) return undefined;
    const requested = this.requestedScope.split(/\s+/u).filter(Boolean);
    const offered = authorizationUrl.searchParams.get('scope')?.split(/\s+/u).filter(Boolean) ?? [];
    if (offered.includes('offline_access') && !requested.includes('offline_access')) {
      requested.push('offline_access');
    }
    return requested.join(' ');
  }
}
