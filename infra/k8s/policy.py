"""Company baseline for the rendered Kubernetes manifests (Template 2).

The Kubernetes counterpart of infra/guard/*.guard. CI runs it on the output
of render.sh for every environment, so a reviewer only has to look at
deliberate exceptions. Changing this file needs an Ops review (CODEOWNERS).

    python infra/k8s/policy.py rendered.yaml          # all documents must pass
    python infra/k8s/policy.py --each-fails tests.yaml # every document must fail
"""

import sys

import yaml

# What the deploy role's "edit" access could create, narrowed to what an app
# needs. Anything else (a Role, a CronJob running as something else, a
# LoadBalancer Service) is a conversation with Ops first.
ALLOWED_KINDS = {
    "ServiceAccount", "ConfigMap", "Secret", "Service", "Deployment",
    "Ingress", "NetworkPolicy", "PodDisruptionBudget", "HorizontalPodAutoscaler",
}
OPEN_CIDRS = {"0.0.0.0/0", "::/0"}
ALB = "alb.ingress.kubernetes.io/"


def check(doc):
    kind = doc.get("kind")
    name = f"{kind}/{doc.get('metadata', {}).get('name')}"
    spec = doc.get("spec") or {}
    errors = []

    def fail(msg):
        errors.append(f"{name}: {msg}")

    if kind not in ALLOWED_KINDS:
        fail(f"kind {kind} is not allowed in Template 2")

    if kind == "Service" and spec.get("type", "ClusterIP") != "ClusterIP":
        fail("Services must be ClusterIP; only the Ingress is exposed, behind login")

    if kind == "Ingress":
        ann = doc.get("metadata", {}).get("annotations") or {}
        if spec.get("ingressClassName") != "alb":
            fail('ingressClassName must be "alb"')
        if ann.get(ALB + "auth-type") != "oidc":
            fail("the load balancer must require login (auth-type: oidc)")
        cidrs = {c.strip() for c in ann.get(ALB + "inbound-cidrs", "").split(",") if c.strip()}
        if not cidrs:
            fail("inbound-cidrs must list the allowed source ranges")
        if cidrs & OPEN_CIDRS:
            fail("inbound-cidrs must not include 0.0.0.0/0 or ::/0")
        if not ann.get(ALB + "certificate-arn"):
            fail("certificate-arn is required; login works only over HTTPS")

    if kind == "Deployment":
        pod = (spec.get("template") or {}).get("spec") or {}
        for key in ("hostNetwork", "hostPID", "hostIPC"):
            if pod.get(key):
                fail(f"{key} is not allowed")
        if any("hostPath" in v for v in pod.get("volumes") or []):
            fail("hostPath volumes are not allowed")
        pod_sc = pod.get("securityContext") or {}
        for c in (pod.get("initContainers") or []) + (pod.get("containers") or []):
            cname = f"container {c.get('name')}"
            sc = c.get("securityContext") or {}
            if not sc.get("runAsNonRoot", pod_sc.get("runAsNonRoot")):
                fail(f"{cname}: runAsNonRoot must be true")
            if sc.get("privileged"):
                fail(f"{cname}: privileged is not allowed")
            if sc.get("allowPrivilegeEscalation", True):
                fail(f"{cname}: allowPrivilegeEscalation must be false")
            if not sc.get("readOnlyRootFilesystem"):
                fail(f"{cname}: readOnlyRootFilesystem must be true")
            if "ALL" not in ((sc.get("capabilities") or {}).get("drop") or []):
                fail(f"{cname}: capabilities must drop ALL")
            if not ((c.get("resources") or {}).get("limits") or {}).get("memory"):
                fail(f"{cname}: a memory limit is required")
            if "@sha256:" not in c.get("image", ""):
                fail(f"{cname}: images must be pinned by digest")

    return errors


def main(argv):
    each_fails = argv[:1] == ["--each-fails"]
    path = argv[-1]
    docs = [d for d in yaml.safe_load_all(open(path)) if d]
    if each_fails:
        # Each test document breaks one rule. Checked one at a time, so a rule
        # that silently stopped matching shows up as MISSED.
        missed = 0
        for doc in docs:
            label = doc.get("metadata", {}).get("name")
            caught = bool(check(doc))
            print(("caught " if caught else "MISSED ") + label)
            missed += not caught
        return 1 if missed else 0
    errors = [e for doc in docs for e in check(doc)]
    for e in errors:
        print(f"::error file={path}::{e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
