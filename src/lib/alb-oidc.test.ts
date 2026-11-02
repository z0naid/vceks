import { SignJWT, exportSPKI, generateKeyPair, type JWTHeaderParameters } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  albConfigFromEnv,
  AlbOidcError,
  clearKeyCache,
  identityFromHeaders,
  verifyAlbOidcToken,
  type AlbOidcErrorCode,
} from "./alb-oidc";

const REGION = "us-east-1";
const ALB_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/staging-alb/50dc6c495c0c9188";
const OTHER_ALB_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:999999999999:loadbalancer/app/someone-elses-alb/deadbeefdeadbeef";

const KID = "b1c2d3e4-1111-2222-3333-444455556666";

const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;
const validExp = Math.floor(NOW_MS / 1000) + 3600;

let signerPem: string;
let signerPrivateKey: CryptoKey;
let attackerPrivateKey: CryptoKey;

beforeAll(async () => {
  const signerPair = await generateKeyPair("ES256", { extractable: true });
  signerPrivateKey = signerPair.privateKey;
  signerPem = await exportSPKI(signerPair.publicKey);

  // A second keypair whose public half is never served, used to sign tokens
  // that the real ALB key will not verify.
  const attackerPair = await generateKeyPair("ES256", { extractable: true });
  attackerPrivateKey = attackerPair.privateKey;
});

beforeEach(() => {
  clearKeyCache();
});

/** Build a token shaped the way an ALB builds one: exp/iss/client in the header. */
async function makeAlbToken(
  overrides: {
    kid?: string | undefined;
    signer?: string | undefined;
    exp?: number | undefined;
    sub?: string | undefined;
    email?: string | undefined;
    alg?: string;
    key?: CryptoKey;
  } = {},
): Promise<string> {
  // `in` rather than destructuring defaults: passing a key explicitly as
  // undefined means "omit this field", which is how the rejection cases are
  // built. A default would silently substitute a valid value instead.
  const kid = "kid" in overrides ? overrides.kid : KID;
  const signer = "signer" in overrides ? overrides.signer : ALB_ARN;
  const exp = "exp" in overrides ? overrides.exp : validExp;
  const sub = "sub" in overrides ? overrides.sub : "user-123";
  const email = "email" in overrides ? overrides.email : "person@example.com";
  const alg = overrides.alg ?? "ES256";
  const key = overrides.key ?? signerPrivateKey;

  const header: JWTHeaderParameters = { alg };
  if (kid !== undefined) header.kid = kid;
  if (signer !== undefined) header.signer = signer;
  if (exp !== undefined) header.exp = exp;
  header.iss = "https://staging.example.com";
  header.client = "client-abc";

  const payload: Record<string, unknown> = {};
  if (sub !== undefined) payload.sub = sub;
  if (email !== undefined) payload.email = email;

  return new SignJWT(payload).setProtectedHeader(header).sign(key);
}

function fetchKeyReturning(pem: string) {
  return vi.fn(async () => pem);
}

function expectCode(err: unknown, code: AlbOidcErrorCode) {
  expect(err).toBeInstanceOf(AlbOidcError);
  expect((err as AlbOidcError).code).toBe(code);
}

describe("verifyAlbOidcToken", () => {
  it("accepts a well-formed token and returns sub and email", async () => {
    const token = await makeAlbToken();
    const identity = await verifyAlbOidcToken(token, {
      expectedSignerArn: ALB_ARN,
      region: REGION,
      fetchKey: fetchKeyReturning(signerPem),
      now,
    });

    expect(identity.sub).toBe("user-123");
    expect(identity.email).toBe("person@example.com");
  });

  it("omits email when the IdP did not release it", async () => {
    const token = await makeAlbToken({ email: undefined });
    const identity = await verifyAlbOidcToken(token, {
      expectedSignerArn: ALB_ARN,
      region: REGION,
      fetchKey: fetchKeyReturning(signerPem),
      now,
    });

    expect(identity.sub).toBe("user-123");
    expect(identity.email).toBeUndefined();
  });

  it("rejects a token signed by a different load balancer", async () => {
    const token = await makeAlbToken({ signer: OTHER_ALB_ARN });

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "signer_mismatch");
      return true;
    });
  });

  it("does not fetch a key when the signer is wrong", async () => {
    const token = await makeAlbToken({ signer: OTHER_ALB_ARN });
    const fetchKey = fetchKeyReturning(signerPem);

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey,
        now,
      }),
    ).rejects.toThrow();

    expect(fetchKey).not.toHaveBeenCalled();
  });

  it("rejects an expired token, whose exp lives in the header", async () => {
    // The whole point: a standard JWT library sees no exp in the payload and
    // waves this through. ALB puts exp in the header.
    const token = await makeAlbToken({ exp: Math.floor(NOW_MS / 1000) - 1 });

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "expired");
      return true;
    });
  });

  it("rejects a token whose signature does not match the served key", async () => {
    const token = await makeAlbToken({ key: attackerPrivateKey });

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        // Attacker signed it; server hands back the real ALB key.
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "bad_signature");
      return true;
    });
  });

  it("rejects an HS256 token signed with the public key as an HMAC secret", async () => {
    // Classic algorithm-confusion attack: the public key is public, so an
    // attacker can HMAC with it and hope the server trusts the header's alg.
    const { createSecretKey } = await import("node:crypto");
    const secret = createSecretKey(Buffer.from(signerPem));
    const confusable = await new SignJWT({ sub: "user-123" })
      .setProtectedHeader({ alg: "HS256", kid: KID, signer: ALB_ARN, exp: validExp })
      .sign(secret);

    await expect(
      verifyAlbOidcToken(confusable, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "bad_alg");
      return true;
    });
  });

  it("rejects an unsigned alg:none token", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "none", kid: KID, signer: ALB_ARN, exp: validExp })}.${b64({
      sub: "user-123",
    })}.`;

    await expect(
      verifyAlbOidcToken(unsigned, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "bad_alg");
      return true;
    });
  });

  it("rejects a token with no kid", async () => {
    const token = await makeAlbToken({ kid: undefined });

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "missing_kid");
      return true;
    });
  });

  it("rejects a token with no signer", async () => {
    const token = await makeAlbToken({ signer: undefined });

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "missing_signer");
      return true;
    });
  });

  it("rejects a token with no exp in the header", async () => {
    const token = await makeAlbToken({ exp: undefined });

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "missing_exp");
      return true;
    });
  });

  it("rejects a verified token that carries no sub", async () => {
    const token = await makeAlbToken({ sub: undefined });

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "missing_sub");
      return true;
    });
  });

  it("rejects structurally malformed tokens", async () => {
    for (const bad of ["", "not-a-jwt", "only.two", "a.b.c.d"]) {
      await expect(
        verifyAlbOidcToken(bad, {
          expectedSignerArn: ALB_ARN,
          region: REGION,
          fetchKey: fetchKeyReturning(signerPem),
          now,
        }),
      ).rejects.toSatisfy((e) => {
        expectCode(e, "malformed");
        return true;
      });
    }
  });

  it("rejects when ALB_SIGNER_ARN is not configured", async () => {
    const token = await makeAlbToken();

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: "",
        region: REGION,
        fetchKey: fetchKeyReturning(signerPem),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "signer_mismatch");
      return true;
    });
  });

  it("propagates a key-fetch failure as key_fetch_failed", async () => {
    const token = await makeAlbToken();

    await expect(
      verifyAlbOidcToken(token, {
        expectedSignerArn: ALB_ARN,
        region: REGION,
        fetchKey: vi.fn(async () => {
          throw new AlbOidcError("key_fetch_failed", "404");
        }),
        now,
      }),
    ).rejects.toSatisfy((e) => {
      expectCode(e, "key_fetch_failed");
      return true;
    });
  });

  it("does not cache a failed key fetch, so a later request can recover", async () => {
    const token = await makeAlbToken();
    let attempts = 0;
    const fetchKey = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new AlbOidcError("key_fetch_failed", "transient");
      return signerPem;
    });

    const opts = { expectedSignerArn: ALB_ARN, region: REGION, now };

    await expect(verifyAlbOidcToken(token, { ...opts, fetchKey })).rejects.toThrow();
    await expect(verifyAlbOidcToken(token, { ...opts, fetchKey })).resolves.toBeTruthy();
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });
});

describe("identityFromHeaders", () => {
  const opts = {
    expectedSignerArn: ALB_ARN,
    region: REGION,
    fetchKey: fetchKeyReturning("unused"),
    now,
  };

  function headersOf(map: Record<string, string>) {
    return (name: string) => map[name.toLowerCase()] ?? null;
  }

  it("returns anonymous when the ALB header is absent", async () => {
    expect(await identityFromHeaders(headersOf({}), opts)).toEqual({ status: "anonymous" });
  });

  it("never trusts the unsigned x-amzn-oidc-identity header", async () => {
    // A forged plaintext header with no signed -data alongside it must not
    // authenticate anyone.
    const result = await identityFromHeaders(
      headersOf({ "x-amzn-oidc-identity": "attacker@evil.example" }),
      opts,
    );

    expect(result).toEqual({ status: "anonymous" });
  });

  it("never trusts the unsigned x-amzn-oidc-accesstoken header", async () => {
    const result = await identityFromHeaders(
      headersOf({ "x-amzn-oidc-accesstoken": "some-token" }),
      opts,
    );

    expect(result).toEqual({ status: "anonymous" });
  });

  it("reports a rejected rather than throwing on a bad token", async () => {
    const result = await identityFromHeaders(headersOf({ "x-amzn-oidc-data": "garbage" }), opts);

    expect(result).toEqual({ status: "rejected", code: "malformed" });
  });

  it("authenticates a valid token", async () => {
    const token = await makeAlbToken();
    const result = await identityFromHeaders(headersOf({ "x-amzn-oidc-data": token }), {
      ...opts,
      fetchKey: fetchKeyReturning(signerPem),
    });

    expect(result.status).toBe("authenticated");
    if (result.status === "authenticated") {
      expect(result.identity.email).toBe("person@example.com");
    }
  });
});

describe("dev identity mock", () => {
  const opts = {
    expectedSignerArn: ALB_ARN,
    region: REGION,
    fetchKey: fetchKeyReturning("unused"),
    now,
  };
  const noHeaders = () => null;

  it("is inert when the opt-in flag is absent", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_DEV_IDENTITY_MOCK", "");
    vi.stubEnv("DEV_IDENTITY_MOCK_EMAIL", "dev@example.com");

    expect(await identityFromHeaders(noHeaders, opts)).toEqual({ status: "anonymous" });
    vi.unstubAllEnvs();
  });

  it("is inert in production even with the flag set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DEV_IDENTITY_MOCK", "true");
    vi.stubEnv("DEV_IDENTITY_MOCK_EMAIL", "dev@example.com");

    expect(await identityFromHeaders(noHeaders, opts)).toEqual({ status: "anonymous" });
    vi.unstubAllEnvs();
  });

  it("is inert without an email", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_DEV_IDENTITY_MOCK", "true");
    vi.stubEnv("DEV_IDENTITY_MOCK_EMAIL", "");

    expect(await identityFromHeaders(noHeaders, opts)).toEqual({ status: "anonymous" });
    vi.unstubAllEnvs();
  });

  it("supplies an identity in development when explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_DEV_IDENTITY_MOCK", "true");
    vi.stubEnv("DEV_IDENTITY_MOCK_EMAIL", "dev@example.com");

    const result = await identityFromHeaders(noHeaders, opts);
    expect(result.status).toBe("authenticated");
    if (result.status === "authenticated") {
      expect(result.identity.email).toBe("dev@example.com");
      expect(result.identity.sub).toBe("dev-mock:dev@example.com");
    }
    vi.unstubAllEnvs();
  });
});

describe("albConfigFromEnv", () => {
  it("returns null when config is incomplete", () => {
    vi.stubEnv("ALB_SIGNER_ARN", "");
    vi.stubEnv("AWS_REGION", REGION);
    expect(albConfigFromEnv()).toBeNull();

    vi.stubEnv("ALB_SIGNER_ARN", ALB_ARN);
    vi.stubEnv("AWS_REGION", "");
    expect(albConfigFromEnv()).toBeNull();

    vi.unstubAllEnvs();
  });

  it("returns config when both values are present", () => {
    vi.stubEnv("ALB_SIGNER_ARN", ALB_ARN);
    vi.stubEnv("AWS_REGION", REGION);

    expect(albConfigFromEnv()).toEqual({ expectedSignerArn: ALB_ARN, region: REGION });
    vi.unstubAllEnvs();
  });
});
