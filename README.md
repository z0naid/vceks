# securly-tool-template

A sample private tool that sits behind an Application Load Balancer requiring
OpenID Connect authentication, intended to become a GitHub template for
internal tools.

The app and its identity verification exist and are tested. **This is the
EKS variant** (branch `eks`): the app runs on a shared EKS cluster instead of
ECS Fargate. See [infra/README.md](infra/README.md).

## Phase status

| # | Phase | State |
|---|-------|-------|
| 1 | Sample app + Dockerfile | **Complete** |
| 2 | AWS + cluster infra (EKS namespace, ALB via Ingress) | Written (`infra/app/`, `infra/k8s/`) |
| 3 | OIDC on the ALB | Written (`infra/k8s/base/ingress.yaml`) |
| 4 | GitHub → AWS auto-deploy | Written (`.github/workflows/deploy.yml`) |
| 5 | Review gate + prod promotion | Written (`production` environment) |

### Phase 1, honestly

- [x] Next.js app, App Router, `output: "standalone"`
- [x] `/api/health` for the target group health check
- [x] `/whoami` reading a **signature-verified** `x-amzn-oidc-data`
- [x] 27 unit tests over the verification logic
- [x] `npm run build` emits standalone output
- [x] `docker build` — 18/18 stages
- [x] `docker run` — container serves, `/api/health` returns 200
- [x] Full attack suite re-run against the container, all rejections hold

Phase 1 is complete. The pipeline builds `linux/amd64`, and the Deployment
pins pods to amd64 nodes. Change both together; a mismatch surfaces as an
exec format error when the pod starts, not at build time.

## Local development

```bash
npm install
npm test          # 27 tests, the meaningful check
npm run dev
```

There is no ALB locally, so `/whoami` has no identity header to read. To render
a stand-in identity:

```bash
ALLOW_DEV_IDENTITY_MOCK=true DEV_IDENTITY_MOCK_EMAIL=you@example.com npm run dev
```

The mock is hard-disabled when `NODE_ENV=production`, which the Dockerfile
bakes in. It cannot activate in a deployed container.

To exercise the real verification path against the built server, use the
"Attacking it locally" recipes below.

## What the ALB actually sends

After `authenticate-oidc` succeeds the load balancer adds three headers:

| Header | Signed? | Contains |
|---|---|---|
| `x-amzn-oidc-data` | **yes**, ES256 JWT | user claims |
| `x-amzn-oidc-accesstoken` | no, plaintext | IdP access token |
| `x-amzn-oidc-identity` | no, plaintext | `sub` |

Only `x-amzn-oidc-data` is signed. AWS is explicit that the other two "are
unsigned and cannot be independently verified", so `src/lib/alb-oidc.ts` never
reads them, and a test asserts that a forged `x-amzn-oidc-identity` alone
authenticates nobody.

Two properties of the ALB token surprise people:

**`exp`, `iss` and `client` live in the JWT header, not the payload.** Every JWT
library — `jose` included — validates `exp` from the *payload*, finds nothing,
and passes. A naive `jwtVerify()` therefore accepts expired tokens. Expiry is
checked by hand in `verifyAlbOidcToken`, and there is a test that would fail if
that check were removed.

**The header carries `signer`, the ARN of the ALB that minted the token.** A
valid signature only proves that *some* ALB signed it — any AWS account can run
one. The signer must equal `ALB_SIGNER_ARN` or the token is refused. That check
runs before any network call or crypto, so a token from a foreign load balancer
is rejected without touching the key endpoint.

## Attacking it locally

These run against the built server and demonstrate the rejections:

```bash
npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cd .next/standalone
ALB_SIGNER_ARN='arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/staging-alb/50dc6c495c0c9188' \
AWS_REGION=us-east-1 PORT=3100 node server.js
```

Then, against `localhost:3100`:

| Request | Result |
|---|---|
| `curl /whoami` | no identity header |
| `curl -H 'x-amzn-oidc-identity: attacker@evil.example' /whoami` | ignored |
| `curl -H 'x-amzn-oidc-data: not-a-jwt' /whoami` | `malformed` |
| token with a different `signer` | `signer_mismatch` |
| token with `alg: HS256` | `bad_alg` |
| token with `exp` in the past | `expired` |

## Configuration

All configuration arrives as environment variables at runtime, from the
`app-config` ConfigMap the deploy generates. Nothing is baked into the image and
no secret is stored in this repo.

| Variable | Required | Purpose |
|---|---|---|
| `ALB_SIGNER_ARN` | yes | The only ALB whose signature is trusted |
| `AWS_REGION` | yes | Locates the public key endpoint |
| `SERVICE_NAME` | no | Appears in the `/api/health` payload |
| `ALLOW_DEV_IDENTITY_MOCK` | dev only | Inert in production |
| `DEV_IDENTITY_MOCK_EMAIL` | dev only | Inert in production |

If `ALB_SIGNER_ARN` or `AWS_REGION` is missing the app refuses every token and
`/whoami` says so explicitly, rather than reporting an authentication failure.

## Two Next.js 16 traps this code already avoids

Both were hit while building Phase 1 and will bite again in later phases.

**Reading config before touching a dynamic API makes a component static.** With
`cacheComponents: true`, a component that never reaches `headers()` is
prerendered at build time. An early return placed *above* the `headers()` call
meant `/whoami` was baked in as "misconfigured" during the build — where
`ALB_SIGNER_ARN` is unset — and then served that frozen result forever, even in
a container where the variables were set correctly. `resolvePanel()` now awaits
`headers()` first, unconditionally.

**`export const dynamic = "force-dynamic"` is rejected.** Under
`cacheComponents` it fails the build outright. It is also unnecessary: an
uncached route handler is dynamic already.

## Health check note for Phase 3

`/api/health` must stay reachable **without** authentication. An ALB health
check follows no redirects and carries no session cookie, so if this path sits
behind an `authenticate-oidc` action the ALB receives a 302, marks the target
unhealthy, and pulls every task out of service.

Phase 3 therefore needs a higher-priority listener rule forwarding `/api/health`
straight to the target group, ahead of the catch-all rule that authenticates.

## Known non-blockers

`npm audit` reports 5 high-severity advisories, all one chain:
`braces` → `micromatch` → `fast-glob` → `@next/eslint-plugin-next`. This is
lint tooling in `devDependencies`; it is not in the runtime image. `npm audit
fix --force` would downgrade `eslint-config-next` to 14.x, so it is not applied.
