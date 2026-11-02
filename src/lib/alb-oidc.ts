import { decodeProtectedHeader, importSPKI, jwtVerify, type JWTPayload } from "jose";

/**
 * Verification of the identity headers an Application Load Balancer injects
 * after a successful `authenticate-oidc` action.
 *
 * The ALB adds three headers:
 *
 *   x-amzn-oidc-data          signed JWT of the user claims  <- the only trustworthy one
 *   x-amzn-oidc-accesstoken   plaintext, unsigned
 *   x-amzn-oidc-identity      plaintext, unsigned
 *
 * AWS signs only `x-amzn-oidc-data`. The other two are legacy plaintext and are
 * trivially forgeable, so they are deliberately never read here.
 *
 * Two details of the ALB token format differ from a normal OIDC ID token:
 *
 *   1. `exp`, `iss` and `client` live in the JWT *header*, not the payload.
 *      `jose` (like every other JWT library) validates `exp` from the payload,
 *      finds nothing, and passes. Expiry must therefore be checked by hand.
 *   2. The header carries `signer`, the ARN of the ALB that minted the token.
 *      Signature validity alone only proves *some* ALB signed it, so the signer
 *      must be compared against the ALB we expect.
 *
 * See https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html
 */

export const OIDC_DATA_HEADER = "x-amzn-oidc-data";

export type AlbIdentity = {
  /** Stable user identifier. AWS recommends `sub` over `email` for authorization. */
  sub: string;
  /** Display-only claim. Not every IdP releases it. */
  email?: string;
  claims: JWTPayload;
};

export type AlbOidcConfig = {
  /** ARN of the ALB whose signature we accept. */
  expectedSignerArn: string;
  /** Region the ALB lives in; locates the public key endpoint. */
  region: string;
};

export type VerifyOptions = AlbOidcConfig & {
  /** Fetch the PEM public key for a `kid`. Injected in tests to avoid network. */
  fetchKey?: (kid: string) => Promise<string>;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
};

export type AlbOidcErrorCode =
  | "malformed"
  | "bad_alg"
  | "missing_kid"
  | "missing_signer"
  | "signer_mismatch"
  | "missing_exp"
  | "expired"
  | "key_fetch_failed"
  | "bad_signature"
  | "missing_sub";

export class AlbOidcError extends Error {
  readonly code: AlbOidcErrorCode;

  constructor(code: AlbOidcErrorCode, message: string) {
    super(message);
    this.name = "AlbOidcError";
    this.code = code;
  }
}

/** Shape of the ALB's JWT header. Note `exp`/`iss`/`client` are in here. */
type AlbJwtHeader = {
  alg?: string;
  kid?: string;
  signer?: string;
  iss?: string;
  client?: string;
  exp?: number;
};

/**
 * Cache of in-flight and resolved keys, keyed by region+kid. ALB keys rotate
 * rarely, and caching the promise (not just the result) collapses a burst of
 * concurrent first requests into a single fetch.
 */
const keyCache = new Map<string, Promise<string>>();

async function defaultFetchKey(region: string, kid: string): Promise<string> {
  const cacheKey = `${region}:${kid}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const pending = (async () => {
    // `kid` is attacker-controlled input landing in a URL path, so encode it.
    const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(kid)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new AlbOidcError("key_fetch_failed", `public key fetch failed with ${res.status}`);
    }
    return res.text();
  })();

  keyCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (err) {
    // Never cache a failure, or one blip poisons the key for the process lifetime.
    keyCache.delete(cacheKey);
    throw err;
  }
}

/** Test seam: drop cached keys. */
export function clearKeyCache(): void {
  keyCache.clear();
}

/**
 * Verify a `x-amzn-oidc-data` token and return the identity it asserts.
 *
 * Throws `AlbOidcError` on anything suspicious. Callers should treat every
 * throw as "not authenticated" rather than surfacing the reason to the user.
 */
export async function verifyAlbOidcToken(
  token: string,
  opts: VerifyOptions,
): Promise<AlbIdentity> {
  const { expectedSignerArn, region, now = Date.now } = opts;
  const fetchKey = opts.fetchKey ?? ((kid: string) => defaultFetchKey(region, kid));

  if (!expectedSignerArn) {
    throw new AlbOidcError("signer_mismatch", "ALB_SIGNER_ARN is not configured");
  }

  // Reject structurally broken tokens before any parsing work.
  if (token.split(".").length !== 3) {
    throw new AlbOidcError("malformed", "token is not a three-part JWT");
  }

  let header: AlbJwtHeader;
  try {
    header = decodeProtectedHeader(token) as AlbJwtHeader;
  } catch {
    throw new AlbOidcError("malformed", "token header is not decodable");
  }

  // Pin the algorithm. This single check is what defeats `alg: none` and
  // alg-confusion (HS256 tokens signed using the public key as an HMAC secret).
  if (header.alg !== "ES256") {
    throw new AlbOidcError("bad_alg", `expected ES256, got ${String(header.alg)}`);
  }

  if (typeof header.kid !== "string" || header.kid === "") {
    throw new AlbOidcError("missing_kid", "token header has no kid");
  }

  if (typeof header.signer !== "string" || header.signer === "") {
    throw new AlbOidcError("missing_signer", "token header has no signer");
  }

  // Cheapest rejection available, and it happens before any network call or
  // crypto: a well-formed token from somebody else's ALB dies here.
  if (header.signer !== expectedSignerArn) {
    throw new AlbOidcError("signer_mismatch", "token was signed by a different load balancer");
  }

  // `exp` is in the header, so jose will not enforce it. Enforce it ourselves.
  if (typeof header.exp !== "number") {
    throw new AlbOidcError("missing_exp", "token header has no exp");
  }
  if (now() >= header.exp * 1000) {
    throw new AlbOidcError("expired", "token has expired");
  }

  const pem = await fetchKey(header.kid);

  let key: CryptoKey;
  try {
    key = await importSPKI(pem, "ES256");
  } catch {
    throw new AlbOidcError("key_fetch_failed", "public key is not a usable ES256 SPKI key");
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key, { algorithms: ["ES256"] }));
  } catch (err) {
    throw new AlbOidcError("bad_signature", `signature check failed: ${(err as Error).message}`);
  }

  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new AlbOidcError("missing_sub", "verified token has no sub claim");
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    claims: payload,
  };
}

export type IdentityResult =
  | { status: "authenticated"; identity: AlbIdentity }
  | { status: "anonymous" }
  | { status: "rejected"; code: AlbOidcErrorCode };

/**
 * Resolve an identity from request headers.
 *
 * Never throws: a page should render "not signed in", not a 500, when the
 * header is absent or untrustworthy.
 */
export async function identityFromHeaders(
  getHeader: (name: string) => string | null,
  opts: VerifyOptions,
): Promise<IdentityResult> {
  const token = getHeader(OIDC_DATA_HEADER);

  if (!token) {
    const mock = devMockIdentity();
    if (mock) return { status: "authenticated", identity: mock };
    return { status: "anonymous" };
  }

  try {
    return { status: "authenticated", identity: await verifyAlbOidcToken(token, opts) };
  } catch (err) {
    return {
      status: "rejected",
      code: err instanceof AlbOidcError ? err.code : "malformed",
    };
  }
}

/**
 * Local development stand-in for the ALB, which cannot exist off-AWS.
 *
 * Deliberately triple-gated: hard-disabled under NODE_ENV=production, requires
 * an explicit opt-in flag, and requires an email to be set. Nothing here can
 * turn on in a deployed container, because NODE_ENV is baked to production in
 * the Dockerfile.
 *
 * Returns a full identity rather than just an email so that local development
 * does not also demand dummy ALB_SIGNER_ARN/AWS_REGION values — the mock stands
 * in for the entire load balancer.
 */
export function devMockIdentity(): AlbIdentity | null {
  if (process.env.NODE_ENV === "production") return null;
  if (process.env.ALLOW_DEV_IDENTITY_MOCK !== "true") return null;
  const email = process.env.DEV_IDENTITY_MOCK_EMAIL?.trim();
  if (!email) return null;
  return { sub: `dev-mock:${email}`, email, claims: { devMock: true } };
}

/** Read ALB config from the environment, returning null if it is incomplete. */
export function albConfigFromEnv(): AlbOidcConfig | null {
  const expectedSignerArn = process.env.ALB_SIGNER_ARN?.trim();
  const region = process.env.AWS_REGION?.trim();
  if (!expectedSignerArn || !region) return null;
  return { expectedSignerArn, region };
}
