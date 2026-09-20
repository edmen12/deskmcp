import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError
} from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import { DeskMcpOAuthProvider, type StaticOAuthClientCredentials } from './dynamic-mcp-oauth.js';
import { PlatformSecretStore } from './platform-secret-store.js';
import type { SecretStore } from './secure-secret-store.js';

const FLOW_TTL_MS = 10 * 60_000;

interface OAuthTarget {
  readonly name: string;
  readonly url: string;
  readonly scope?: string;
  readonly static_client?: {
    readonly client_id: string;
    readonly client_secret_env?: string;
    readonly token_endpoint_auth_method: 'client_secret_basic' | 'client_secret_post' | 'none';
  };
  readonly timeout_ms: number;
}

interface PendingOAuthFlow {
  readonly targetKey: string;
  readonly provider: DeskMcpOAuthProvider;
  readonly transport: StreamableHTTPClientTransport;
  readonly client: Client;
  readonly createdAt: number;
}

export interface DynamicMcpOAuthStartResult {
  readonly name: string;
  readonly status: 'authorization_required' | 'already_authenticated';
  readonly authorization_url?: string;
  readonly callback_url: string;
}

function isLoopbackUrl(value: string): boolean {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return parsed.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '::1');
}

function targetKey(target: OAuthTarget): string {
  return createHash('sha256')
    .update(JSON.stringify([
      target.name,
      target.url,
      target.scope ?? '',
      target.static_client?.client_id ?? '',
      target.static_client?.client_secret_env ?? '',
      target.static_client?.token_endpoint_auth_method ?? ''
    ]), 'utf8')
    .digest('hex');
}

export class DynamicMcpOAuthManager {
  private callbackBaseUrl: string | undefined;
  private readonly pending = new Map<string, PendingOAuthFlow>();

  constructor(
    readonly root: string,
    private readonly store: SecretStore = new PlatformSecretStore(root)
  ) {}

  setCallbackBaseUrl(baseUrl: string): void {
    const parsed = new URL(baseUrl);
    if (!isLoopbackUrl(parsed.toString())) {
      throw new Error('Dynamic MCP OAuth callback base URL must use loopback HTTP.');
    }
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    this.callbackBaseUrl = parsed.toString().replace(/\/$/u, '');
  }

  callbackUrl(name: string): string {
    if (!this.callbackBaseUrl) throw new Error('Dynamic MCP OAuth callback URL is not initialized.');
    return `${this.callbackBaseUrl}/oauth/callback/${encodeURIComponent(name)}`;
  }

  private storageKey(target: OAuthTarget): string {
    return `dynamic-mcp:${targetKey(target)}`;
  }

  private staticClient(target: OAuthTarget, requireSecret: boolean): StaticOAuthClientCredentials | undefined {
    const configured = target.static_client;
    if (!configured) return undefined;
    const secret = configured.client_secret_env === undefined
      ? undefined
      : process.env[configured.client_secret_env];
    if (requireSecret && configured.token_endpoint_auth_method !== 'none' && !secret) {
      throw new Error(
        `OAuth client secret environment variable is not configured: ${configured.client_secret_env ?? '(missing configuration)'}.`
      );
    }
    return {
      clientId: configured.client_id,
      ...(secret ? { clientSecret: secret } : {}),
      tokenEndpointAuthMethod: configured.token_endpoint_auth_method
    };
  }

  private async createProvider(
    target: OAuthTarget,
    onRedirect?: (url: URL) => void | Promise<void>,
    requireStaticSecret = true
  ): Promise<DeskMcpOAuthProvider> {
    await this.store.init?.();
    const provider = new DeskMcpOAuthProvider(
      this.storageKey(target),
      this.store,
      this.callbackUrl(target.name),
      target.scope,
      onRedirect,
      this.staticClient(target, requireStaticSecret)
    );
    await provider.init();
    return provider;
  }

  async authProvider(target: OAuthTarget): Promise<DeskMcpOAuthProvider> {
    return this.createProvider(target);
  }

  async status(target: OAuthTarget): Promise<unknown> {
    const provider = await this.createProvider(target, undefined, false);
    return {
      name: target.name,
      callback_url: this.callbackUrl(target.name),
      ...(await provider.publicStatus()),
      ...(target.static_client ? {
        static_client: {
          client_id: target.static_client.client_id,
          token_endpoint_auth_method: target.static_client.token_endpoint_auth_method,
          client_secret_configured: target.static_client.client_secret_env
            ? Boolean(process.env[target.static_client.client_secret_env])
            : true
        }
      } : {}),
      pending_authorization: this.pending.has(target.name)
    };
  }

  async disconnect(target: OAuthTarget): Promise<unknown> {
    await this.closePending(target.name);
    await this.store.init?.();
    await this.store.delete(this.storageKey(target));
    return {
      name: target.name,
      disconnected: true,
      configured: true,
      authenticated: false
    };
  }

  async start(
    target: OAuthTarget,
    requestHeaders: Readonly<Record<string, string>>,
    force = false
  ): Promise<DynamicMcpOAuthStartResult> {
    await this.closePending(target.name);
    const callbackUrl = this.callbackUrl(target.name);
    let capturedAuthorizationUrl: URL | undefined;
    await this.store.init?.();
    const provider = await this.createProvider(
      target,
      url => { capturedAuthorizationUrl = new URL(url); }
    );
    if (force) {
      await provider.invalidateCredentials?.('tokens');
      await provider.invalidateCredentials?.('verifier');
    }

    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      authProvider: provider,
      requestInit: { headers: { ...requestHeaders } }
    });
    const client = new Client({ name: 'deskmcp-mcp-hub', version: '0.9.14' });

    try {
      await client.connect(transport);
      await client.close().catch(() => undefined);
      return {
        name: target.name,
        status: 'already_authenticated',
        callback_url: callbackUrl
      };
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !capturedAuthorizationUrl) {
        await transport.close().catch(() => undefined);
        throw error;
      }
      this.pending.set(target.name, {
        targetKey: targetKey(target),
        provider,
        transport,
        client,
        createdAt: Date.now()
      });
      return {
        name: target.name,
        status: 'authorization_required',
        authorization_url: capturedAuthorizationUrl.toString(),
        callback_url: callbackUrl
      };
    }
  }

  async finishCallback(target: OAuthTarget, params: URLSearchParams): Promise<unknown> {
    const pending = this.pending.get(target.name);
    if (!pending) throw new Error('No pending OAuth authorization exists for this Dynamic MCP server.');
    if (Date.now() - pending.createdAt > FLOW_TTL_MS) {
      await this.closePending(target.name);
      throw new Error('Dynamic MCP OAuth authorization expired. Start authorization again.');
    }
    if (pending.targetKey !== targetKey(target)) {
      await this.closePending(target.name);
      throw new Error('Dynamic MCP server configuration changed during OAuth authorization.');
    }

    const expectedState = pending.provider.expectedState;
    const receivedState = params.get('state');
    if (!expectedState || !receivedState || expectedState !== receivedState) {
      await this.closePending(target.name);
      throw new Error('Dynamic MCP OAuth state validation failed.');
    }
    if (params.has('error')) {
      await this.closePending(target.name);
      throw new Error('Dynamic MCP OAuth authorization was denied or failed.');
    }

    try {
      await pending.transport.finishAuth(params);
      return {
        name: target.name,
        ...(await pending.provider.publicStatus())
      };
    } finally {
      await this.closePending(target.name);
    }
  }

  private async closePending(name: string): Promise<void> {
    const pending = this.pending.get(name);
    if (!pending) return;
    this.pending.delete(name);
    await pending.client.close().catch(async () => {
      await pending.transport.close().catch(() => undefined);
    });
  }
}
