# Infrastructure templates (EKS)

Every internal tool runs on a **shared EKS cluster**, in its own namespaces
(`<app>-staging`, `<app>-prod`). It deploys through GitHub Actions only;
nobody changes AWS or the cluster by hand. The cluster itself, its network
and its nodes belong to Ops.

| | Template 1: security | Template 2: app |
|---|---|---|
| Files | [`security/security.yaml`](security/security.yaml) | [`app/aws.yaml`](app/aws.yaml), [`k8s/base/`](k8s/base/) |
| Contains | IAM roles, permissions boundary, ECR repository, login secrets, the app's access to the cluster | Pod role permissions, app secrets; Deployment, Service, Ingress (load balancer + login), NetworkPolicy |
| Reviewed by | Ops (CODEOWNERS) | The app team |
| Deployed by | [`security-stack.yml`](../.github/workflows/security-stack.yml), after Ops approval | [`deploy.yml`](../.github/workflows/deploy.yml), on every merge to `main` |
| How often | Project creation, or when the app needs a new AWS service | Every change |

## What a cluster must provide

The template assumes as little as possible about the company cluster:

| Needed | Why |
|---|---|
| Access entries (`API` authentication mode) | Limits each tool's deploy role to its own namespace |
| EKS Pod Identity agent | Gives the app's pods an IAM role |
| AWS Load Balancer Controller, with an IngressClass named `alb` | Builds the load balancer, the login and the IP allow-list from the Ingress |
| amd64 nodes | The image is built for amd64 |

EKS Auto Mode provides all of these. [`ops/sandbox-eks.yaml`](ops/sandbox-eks.yaml)
creates such a cluster for rehearsal.

## How access is limited

```
GitHub Actions ──OIDC──▶ <app>-gh-deploy-<env>
    AWS:        push image, run change sets on <app>-<env>-aws, pass one role, own secrets
    Kubernetes: "edit" in namespace <app>-<env> only          (EKS access entry, Template 1)
                    │ iam:PassRole
                    ▼
CloudFormation ──▶ <app>-cfn-exec      inline policies on <app>-app-*-pod only, own secrets
                    ▼
Pods ──Pod Identity──▶ <app>-app-<env>-pod  ≤  <app>-workload-boundary
```

1. **The permissions boundary.** Template 1 creates the pod roles with
   `<app>-workload-boundary`, the most the app can ever do: its own secrets,
   parameters, buckets, metrics and database auth. Template 2 writes the
   roles' permissions, so developers refine least privilege without Ops, but
   nothing they write can exceed the boundary.
2. **The pod role's trust policy** accepts only Pod Identity sessions from
   this cluster, for service account `app` in the app's own namespace.
3. **Namespace-scoped cluster access.** The deploy role has the built-in
   `edit` access in its namespace only. It cannot create namespaces, change
   RBAC or touch other tools.
4. **Namespace labels set by Ops.** `pod-security.kubernetes.io/enforce:
   restricted` makes the cluster refuse root or privileged pods, whatever the
   manifests say. The deploy role cannot change these labels.
5. **Pull-request checks.** [`guard/app.guard`](guard/app.guard) for
   `aws.yaml`, and [`k8s/policy.py`](k8s/policy.py) on the rendered manifests.

## Baseline

These are defaults, not hard limits. To change one for a specific deployment,
edit the template and explain why in the pull request. Every default carries a
comment where it is set.

| Requirement | Where it is set | Checked by |
|---|---|---|
| Least-privilege roles | Every policy in `security.yaml`; pod role permissions in `aws.yaml` | review; boundary |
| No `<service>:*` or `*` actions | All policies | `baseline.guard`: `iam_*_no_wildcard_actions` |
| No `0.0.0.0/0` ingress | Ingress `inbound-cidrs` from `ingressCidrs` in `config.json` | `policy.py` |
| Login required | Ingress `auth-type: oidc` | `policy.py` |
| Pods not root, no privilege escalation, read-only root filesystem | `k8s/base/deployment.yaml` | `policy.py`, and the namespace's Pod Security label |
| Only private services | Service type `ClusterIP`; the Ingress is the only way in | `policy.py` |
| NACL denies 22 and 3389, IMDSv2, EBS encryption | **The cluster** (Ops); Auto Mode nodes require IMDSv2 and encrypt volumes | `baseline.guard` on `ops/sandbox-eks.yaml` |
| CloudWatch/SSM-only instance role | **The cluster's node role** (Ops) | review |
| RDS/ElastiCache encrypted, not public | `app/examples/` | `baseline.guard` |

Also enforced: no IAM users or access keys, images are deployed by digest,
plain HTTP only redirects, and production promotes the image staging tested.

### Deliberate exceptions for reviewers

- **Egress on tcp/443 to anywhere** (NetworkPolicy). The tasks reach AWS APIs,
  ECR and the load balancer's signing-key endpoint, none with fixed IPs.
- **NetworkPolicy needs cluster support.** It is only enforced if network
  policy is enabled on the cluster (an Ops setting). Without it the policy is
  ignored and pods can reach each other.
- **`Resource: "*"`** appears only for actions that have no resource-level
  support (Describe calls, `ecr:GetAuthorizationToken`, create calls whose
  resource does not exist yet). Each one has a comment.

## Per-environment settings

[`app/config.json`](app/config.json) holds everything that differs between
staging and production: replicas, host name, certificate, allowed IP ranges
and the login client. [`k8s/render.sh`](k8s/render.sh) combines it with
`k8s/base/` into the manifests that are deployed. CI runs the same script,
so the checks see exactly what would be deployed. To see it locally:

```bash
infra/k8s/render.sh staging
```

## Setting up a new app

### One-time setup by Ops, per account and cluster

1. Deploy [`ops/account.yaml`](ops/account.yaml), the GitHub OIDC provider,
   unless the account already has it:
   ```bash
   aws cloudformation deploy --stack-name account-github-oidc \
     --template-file infra/ops/account.yaml
   ```
2. On an EKS Auto Mode cluster, create the `alb` IngressClass:
   `kubectl apply -f infra/ops/k8s/cluster.yaml`. A cluster that runs the
   load balancer controller itself already has one.

### Per app: Ops

1. Create the namespaces, with the Pod Security labels:
   ```bash
   sed 's/__APP__/<app>/g' infra/ops/k8s/tool-namespaces.yaml | kubectl apply -f -
   ```
2. Deploy [`ops/tool-deployer.yaml`](ops/tool-deployer.yaml), the role the
   Security stack workflow assumes:
   ```bash
   aws cloudformation deploy --stack-name <app>-ops-deployer \
     --template-file infra/ops/tool-deployer.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides AppName=<app> GitHubOrg=<org> GitHubRepo=<repo> ClusterName=<cluster>
   ```
   No workflow deploys it, so the repo can never widen its own permissions.
3. Register an OIDC client in the company identity provider with callback
   `https://<host>/oauth2/idpresponse` (one per environment), and give the
   team the client secret.

### Per app: the team

1. Fill in [`security/config.json`](security/config.json) and
   [`app/config.json`](app/config.json). A deploy fails while any value is
   still `REPLACE_ME`.
2. In GitHub, create three environments:
   - `security`: required reviewers from Ops, and the variable
     `SECURITY_DEPLOY_ROLE_ARN` (the `tool-deployer` stack's output).
   - `staging`: the secret `OIDC_CLIENT_SECRET`.
   - `production`: required reviewers, and the secret `OIDC_CLIENT_SECRET`.
3. Protect `main`: require pull requests, the **Checks** workflow, and review
   from Code Owners.
4. Merge. **Security stack** runs and waits for Ops approval. **Deploy** also
   starts and fails until the security stack exists; that is expected once.
5. Run **Set secret** with name `oidc`, once for `staging` and once for
   `production`.
6. Run **Deploy**. It deploys staging, then waits for approval to promote to
   production. On the first deploy of each environment it applies twice: the
   app needs the load balancer's ARN, which exists only after the first apply.

## Changing permissions later

- **Within the boundary** (the app's own secrets, parameters, buckets,
  database auth): add a statement to `PodPermissions` in `app/aws.yaml` and
  open a pull request. No Ops review is needed.
- **A new AWS service:** add its runtime actions to `WorkloadBoundary` in
  `security/security.yaml`, and, if Template 2 creates the resource, its
  create, update and delete actions to `CfnExecPolicy`. CODEOWNERS brings in
  Ops, who approve the pull request and then the Security stack run.
- **An AccessDenied while deploying:** the failed CloudFormation event names
  the exact action. Add that action only; the guard rules reject wildcards.
- **Forbidden in Kubernetes:** the deploy role has `edit` in its namespace
  only. Anything else (a CRD, a cluster role, another namespace) is Ops work.

## App secrets

Declare the secret in `app/aws.yaml` under `<app>/app/<env>/<NAME>` (there is
a commented example), add `NAME` to `appSecrets` in `app/config.json`, and
deploy. Then add a GitHub secret `APP_SECRET_<NAME>` on the environment and
run **Set secret** with that name. Each deploy copies the listed secrets into
the namespace, and the container gets them as environment variables. A
changed value restarts the pods.

## Rehearsing in a sandbox account

1. As an admin: deploy [`ops/sandbox-eks.yaml`](ops/sandbox-eks.yaml) as
   stack `sandbox-eks` (about 15 minutes), then
   `aws eks update-kubeconfig --name sandbox` and the Ops steps above.
2. [`ops/sandbox-idp.yaml`](ops/sandbox-idp.yaml) creates a Cognito user pool
   to stand in for the company identity provider.

Things that will come up:

- **No domain:** leave `host` empty, import a self-signed certificate for
  `*.<region>.elb.amazonaws.com` once, and put its ARN in `certificateArn`.
  The browser warns; click through.
- **Login callback:** the callback URL is the load balancer's address, which
  exists only after the first deploy. Deploy, then redeploy `sandbox-idp.yaml`
  with `CallbackUrls` set to both environments' `https://<alb>/oauth2/idpresponse`.
- **The app times out:** check that your public IP is still in `ingressCidrs`.
- **No load balancer appears:** `kubectl -n <app>-staging describe ingress app`
  shows the controller's events, such as a missing certificate.
- **First Security stack run fails:** the stack ends in `ROLLBACK_COMPLETE`
  and cannot be updated. The workflow says so. Fix the cause, have Ops delete
  the stack, and re-run.
- **Cost:** about 5-7 USD a day. Delete the tool's namespaces first (so the
  load balancers go away), then the stacks.

## Layout

```
infra/
  security/security.yaml   Template 1
  security/config.json     its parameters
  app/aws.yaml             Template 2: pod role permissions, app secrets
  app/config.json          per-environment settings
  app/examples/            RDS, ElastiCache with the baseline defaults
  k8s/base/                Template 2: Deployment, Service, Ingress, NetworkPolicy
  k8s/render.sh            base + config.json -> manifests for one environment
  k8s/policy.py            Kubernetes baseline rules (checked in CI)
  k8s/tests/               manifests the rules must reject
  guard/baseline.guard     CloudFormation rules for every template
  guard/app.guard          extra rules for app/
  guard/tests/             templates the rules must reject
  ops/account.yaml         Ops, once per account: GitHub OIDC provider
  ops/tool-deployer.yaml   Ops, once per tool: role for the Security stack workflow
  ops/k8s/cluster.yaml     Ops, once per Auto Mode cluster: the "alb" IngressClass
  ops/k8s/tool-namespaces.yaml   Ops, once per tool: namespaces and their labels
  ops/sandbox-eks.yaml     sandbox only: an Auto Mode cluster
  ops/sandbox-idp.yaml     sandbox only: Cognito stand-in for the company IdP
.github/
  workflows/ci.yml         lint, tests, cfn-lint, cfn-guard, manifest checks (every PR)
  workflows/deploy.yml     build once, staging, then production
  workflows/security-stack.yml   Template 1, behind Ops approval
  workflows/set-secret.yml       copies login and app secrets into Secrets Manager
  actions/deploy-env/      shared deploy steps for one environment
  CODEOWNERS
```

## Open questions for Ops

1. **The cluster.** One shared cluster per environment or one for both? Which
   account? Is the AWS Load Balancer Controller installed, and is network
   policy enforcement on?
2. **How the company deploys to it.** If it uses ArgoCD or Flux, the deploy
   step changes to "commit the new digest" and the rest stays.
3. **Pod security groups.** On Auto Mode all pods share the cluster security
   group, so a database allowed from it is reachable from every tool.
   Security groups for pods would narrow that per app.
4. **DNS.** The load balancer is created by the controller, so CloudFormation
   cannot point a record at it. Is external-dns available, or does Ops add
   records?
5. **Machine clients.** Every path requires a browser login, so scripts and
   other services cannot call a tool's API. Is that acceptable?
