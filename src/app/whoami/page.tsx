import Link from "next/link";
import { Suspense } from "react";
import { headers } from "next/headers";
import {
  albConfigFromEnv,
  devMockIdentity,
  identityFromHeaders,
  type AlbIdentity,
} from "@/lib/alb-oidc";

export const metadata = { title: "Who am I" };

/**
 * Every outcome this page can render, kept as an explicit union.
 *
 * "unconfigured" is deliberately distinct from "rejected": one means the
 * operator forgot to set ALB_SIGNER_ARN/AWS_REGION, the other means a token
 * arrived and failed verification. Collapsing them makes a misconfigured
 * deployment look like an authentication failure and sends you hunting in the
 * wrong place.
 */
type Panel =
  | { kind: "authenticated"; identity: AlbIdentity }
  | { kind: "anonymous" }
  | { kind: "rejected"; code: string }
  | { kind: "unconfigured" };

async function resolvePanel(): Promise<Panel> {
  // Touch a dynamic API FIRST, unconditionally, before any early return.
  //
  // Under cacheComponents a component that never reaches a dynamic API is
  // treated as static and its output is baked in at build time. Checking config
  // before this line would mean that at build time — where ALB_SIGNER_ARN is
  // unset — the component short-circuits to "unconfigured" without ever calling
  // headers(), gets prerendered, and then serves that frozen result forever,
  // even in a container where the variables are set correctly at runtime.
  const headerList = await headers();

  const config = albConfigFromEnv();
  if (!config) {
    // No ALB config. The development mock stands in for the entire load
    // balancer, so it is consulted before declaring the app misconfigured.
    const mock = devMockIdentity();
    if (mock) return { kind: "authenticated", identity: mock };
    return { kind: "unconfigured" };
  }

  const result = await identityFromHeaders((name) => headerList.get(name), config);

  if (result.status === "authenticated") {
    return { kind: "authenticated", identity: result.identity };
  }
  if (result.status === "rejected") return { kind: "rejected", code: result.code };
  return { kind: "anonymous" };
}

/**
 * Split into its own component because it touches `headers()`, a dynamic API:
 * under Next's cacheComponents it has to sit inside a Suspense boundary so the
 * surrounding page can still be prerendered.
 */
async function IdentityPanel() {
  const panel = await resolvePanel();

  switch (panel.kind) {
    case "authenticated":
      return (
        <div>
          <p>
            <strong>Signed in as {panel.identity.email ?? panel.identity.sub}</strong>
          </p>
          <dl>
            <dt>sub</dt>
            <dd>
              <code>{panel.identity.sub}</code>
            </dd>
            {panel.identity.email ? (
              <>
                <dt>email</dt>
                <dd>
                  <code>{panel.identity.email}</code>
                </dd>
              </>
            ) : null}
          </dl>
          {panel.identity.claims.devMock ? (
            <p>
              <em>
                This identity came from the development mock, not from a load balancer. It is
                impossible to reach in a production container.
              </em>
            </p>
          ) : null}
        </div>
      );

    case "rejected":
      return (
        <div>
          <p>
            <strong>Not signed in.</strong> An identity header was present but failed verification
            with code <code>{panel.code}</code>.
          </p>
        </div>
      );

    case "unconfigured":
      return (
        <div>
          <p>
            <strong>Misconfigured.</strong> <code>ALB_SIGNER_ARN</code> and <code>AWS_REGION</code>{" "}
            are not both set, so this app will not trust any token. This is an operator error, not
            an authentication failure.
          </p>
        </div>
      );

    case "anonymous":
      return (
        <div>
          <p>
            <strong>Not signed in.</strong> No load balancer identity header on this request.
          </p>
          <p>
            Locally this is expected: there is no ALB in front of the dev server. Set{" "}
            <code>ALLOW_DEV_IDENTITY_MOCK=true</code> and <code>DEV_IDENTITY_MOCK_EMAIL</code> to
            render a stand-in identity.
          </p>
        </div>
      );
  }
}

export default function WhoAmIPage() {
  return (
    <main>
      <h1>Who am I</h1>
      <p>
        This page exists to prove that ALB OpenID Connect authentication reaches the application. It
        shows only what came out of a signature-verified <code>x-amzn-oidc-data</code> token.
      </p>
      <Suspense fallback={<p>Checking identity&hellip;</p>}>
        <IdentityPanel />
      </Suspense>
      <p>
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
