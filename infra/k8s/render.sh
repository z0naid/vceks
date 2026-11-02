#!/usr/bin/env bash
# Renders the Kubernetes manifests for one environment to stdout.
#
#   infra/k8s/render.sh <staging|prod> [image@sha256:digest] [alb-arn]
#
# Used by both CI (checks run on exactly what would be deployed) and the
# deploy. Per-environment values come from infra/app/config.json; the
# manifests in base/ stay the same for every environment. If APP_SECRETS_DIR
# is set, each file in it becomes one key of the app-secrets Secret.
set -euo pipefail

ENV_NAME=${1:?usage: render.sh <staging|prod> [image] [alb-arn]}
# CI has no image yet; any well-formed digest will do for the checks.
IMAGE=${2:-example.invalid/app@sha256:0000000000000000000000000000000000000000000000000000000000000000}
ALB_ARN=${3:-}

HERE=$(cd "$(dirname "$0")" && pwd)
CFG="$HERE/../app/config.json"
OUT="$HERE/.out/$ENV_NAME"
rm -rf "$OUT"
mkdir -p "$OUT"

APP=$(jq -r .appName "$CFG")
REGION=$(jq -r .awsRegion "$CFG")
if ! jq -e --arg e "$ENV_NAME" '.environments[$e]' "$CFG" >/dev/null; then
  echo "render.sh: no environment \"$ENV_NAME\" in $CFG" >&2
  exit 1
fi

SECRETS='[]'
if [ -n "${APP_SECRETS_DIR:-}" ]; then
  cp -r "$APP_SECRETS_DIR" "$OUT/secrets"
  SECRETS=$(cd "$OUT/secrets" && ls | jq -R . | jq -s .)
fi

# The generated layer: the base, plus everything that differs per
# environment. Generators give the ConfigMap and Secret a content hash in
# their name, so a changed value rolls the pods automatically.
jq -n \
  --argjson cfg "$(jq --arg e "$ENV_NAME" '.environments[$e]' "$CFG")" \
  --arg ns "$APP-$ENV_NAME" \
  --arg image_name "${IMAGE%@*}" \
  --arg image_digest "${IMAGE#*@}" \
  --arg region "$REGION" \
  --arg service "$APP-$ENV_NAME" \
  --arg alb "$ALB_ARN" \
  --argjson secrets "$SECRETS" '
  def ann($k; $v): {op: "add", path: "/metadata/annotations/alb.ingress.kubernetes.io~1\($k)", value: $v};
  {
    apiVersion: "kustomize.config.k8s.io/v1beta1",
    kind: "Kustomization",
    namespace: $ns,
    resources: ["../../base"],
    images: [{name: "app", newName: $image_name, digest: $image_digest}],
    replicas: [{name: "app", count: $cfg.replicas}],
    configMapGenerator: [{
      name: "app-config",
      literals: (["AWS_REGION=\($region)", "SERVICE_NAME=\($service)"]
                 + (if $alb != "" then ["ALB_SIGNER_ARN=\($alb)"] else [] end))
    }],
    secretGenerator: (if ($secrets | length) > 0
      then [{name: "app-secrets", files: ($secrets | map("\(.)=secrets/\(.)"))}]
      else [] end),
    patches: [{
      target: {kind: "Ingress", name: "app"},
      patch: ([
        ann("scheme"; $cfg.scheme),
        ann("inbound-cidrs"; $cfg.ingressCidrs | join(",")),
        ann("certificate-arn"; $cfg.certificateArn),
        ann("auth-idp-oidc"; {
          issuer: $cfg.oidc.issuer,
          authorizationEndpoint: $cfg.oidc.authorizationEndpoint,
          tokenEndpoint: $cfg.oidc.tokenEndpoint,
          userInfoEndpoint: $cfg.oidc.userInfoEndpoint,
          secretName: "oidc"
        } | tojson)
      ] + (if $cfg.host != "" then [{op: "add", path: "/spec/rules/0/host", value: $cfg.host}] else [] end)
      | tojson)
    }]
  }' > "$OUT/kustomization.yaml"

kubectl kustomize "$OUT"
