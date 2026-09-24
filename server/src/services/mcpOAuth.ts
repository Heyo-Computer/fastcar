/**
 * OAuth for deployed MCP servers.
 *
 * The MCP authorization spec has a remote server answer 401 and point at an
 * OAuth 2.1 authorization server. The SDK already knows the whole dance —
 * protected-resource and authorization-server discovery, dynamic client
 * registration or a URL-based client id (CIMD), PKCE, token exchange and
 * refresh — through its OAuthClientProvider interface. What it cannot do is decide where
 * credentials live or how a user gets sent to sign in; that is this class.
 *
 * Two fastcar-specific choices:
 *
 * - Storage is one encrypted JSON blob per server (`mcp_servers.oauth_enc`),
 *   written through a `persist` callback. For a server still mid-install the
 *   callback holds it in memory only, so an abandoned sign-in leaves nothing
 *   behind — the same "nothing registered until it answers tools/list" rule
 *   the stdio installer follows.
 *
 * - The server has no browser to redirect. `redirectToAuthorization` just
 *   captures the URL; McpManager surfaces it to the UI (a link the user clicks)
 *   or to the agent (a URL it hands the user). A browser popup opened after an
 *   await would be blocked, so the UI never tries.
 */
import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

type DiscoveryState = NonNullable<Awaited<ReturnType<NonNullable<OAuthClientProvider["discoveryState"]>>>>;

/** Everything the OAuth flow needs to remember between requests. */
export interface OAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: DiscoveryState;
}

/** Where the authorization server sends the browser back to. */
export const OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

/**
 * fastcar's Client ID Metadata Document (CIMD, SEP-991). Some authorization
 * servers (Loops) offer no dynamic client registration; instead the client's
 * `client_id` *is* an HTTPS URL, and the server fetches it to learn the
 * redirect URIs. So this path must be publicly reachable — it is listed in
 * deploy/fastcar.json auth.public_paths — and it only works when
 * FASTCAR_PUBLIC_URL is https and reachable from the provider.
 */
export const OAUTH_CLIENT_METADATA_PATH = "/api/mcp/oauth/client-metadata.json";

/** The registration fastcar presents, whether sent to /register or served as a CIMD. */
export function oauthClientMetadata(callbackUrl: string): OAuthClientMetadata {
  return {
    client_name: "fastcar",
    redirect_uris: [callbackUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // A public client: PKCE carries the proof, there is no secret to leak.
    token_endpoint_auth_method: "none",
  };
}

/**
 * The CIMD URL for a deployment, or undefined when it cannot be one: the SDK
 * rejects non-https client ids outright, which would break the dynamic
 * registration fallback too.
 */
export function clientMetadataUrlFor(publicUrl: string): string | undefined {
  return publicUrl.startsWith("https://") ? `${publicUrl}${OAUTH_CLIENT_METADATA_PATH}` : undefined;
}

export class McpOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK wants the user sent to sign in. */
  pendingAuthorizationUrl: URL | null = null;
  /**
   * The OAuth `state` parameter. It doubles as the capability that lets the
   * unauthenticated-looking callback find this flow — see the callback route
   * for why that endpoint cannot require the admin token.
   */
  readonly oauthState = randomBytes(24).toString("base64url");

  constructor(
    private data: OAuthState,
    private readonly callbackUrl: string,
    private readonly persist: (data: OAuthState) => Promise<void>,
    /** Used as the client_id when the authorization server supports CIMD. */
    readonly clientMetadataUrl?: string,
  ) {}

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return oauthClientMetadata(this.callbackUrl);
  }

  state(): string {
    return this.oauthState;
  }

  /** True once there is an access token to try — whether or not it still works. */
  hasTokens(): boolean {
    return Boolean(this.data.tokens?.access_token);
  }

  snapshot(): OAuthState {
    return { ...this.data };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    this.data.clientInformation = info;
    await this.persist(this.data);
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.data.tokens = tokens;
    await this.persist(this.data);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuthorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.data.codeVerifier = codeVerifier;
    await this.persist(this.data);
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) throw new Error("no PKCE code verifier saved for this sign-in");
    return this.data.codeVerifier;
  }

  async saveDiscoveryState(state: DiscoveryState): Promise<void> {
    this.data.discoveryState = state;
    await this.persist(this.data);
  }

  discoveryState(): DiscoveryState | undefined {
    return this.data.discoveryState;
  }

  /** The SDK calls this when a credential is rejected, so the next attempt starts clean. */
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") delete this.data.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.data.tokens;
    if (scope === "all" || scope === "verifier") delete this.data.codeVerifier;
    if (scope === "all" || scope === "discovery") delete this.data.discoveryState;
    await this.persist(this.data);
  }
}
