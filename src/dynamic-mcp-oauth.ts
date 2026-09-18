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
    private readonly onRedirect?: (url: URL) => void | Promise<void>
  ) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    this.stateValue = parseState(await this.store.get(this.storageKey));
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
    if (!ctx) return undefined;
    return this.stateValue.clients[ctx.issuer];
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext
  ): Promise<void> {
    await this.init();
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
    this.authorizationUrlValue = new URL(authorizationUrl);
    await this.onRedirect?.(new URL(authorizationUrl));
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
}
