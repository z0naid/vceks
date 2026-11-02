# Infrastructure templates

Every internal tool deploys with the same two CloudFormation templates, through
GitHub Actions only. Nobody changes AWS by hand.

| | Template 1: security | Template 2: app |
|---|---|---|
| Files | [`security/security.yaml`](security/security.yaml) | [`app/network.yaml`](app/network.yaml), [`app/app.yaml`](app/app.yaml) |
| Contains | IAM roles, permissions boundary, ECR repository, login secrets | VPC, NACLs, load balancer, certificate, DNS, ECS, app task roles |
| Reviewed by | Ops (CODEOWNERS) | The app team |
| Deployed by | [`security-stack.yml`](../.github/workflows/security-stack.yml), after Ops approval | [`deploy.yml`](../.github/workflows/deploy.yml), on every merge to `main` |
| How often | Project creation, or when the app needs a new AWS service | Every change |

## How developers can create roles without escalating

Least privilege means task roles change as the app changes, so Template 2 is
allowed to create them. Three limits stop that from becoming a way to escalate
privileges:

1. **The permissions boundary.** Template 1 defines `<app>-workload-boundary`,
   the most any app role can ever do: its own logs, secrets, parameters, buckets
   and database auth. The boundary allows no IAM, STS or Organizations actions.
2. **The CloudFormation execution role** (`<app>-cfn-exec`) can create roles
   only when they are named `<app>-app-*` and carry that boundary. It is denied
   any action that would remove the boundary or change it.
3. **The pull-request rules** ([`guard/app.guard`](guard/app.guard)) also
   require that app roles trust AWS services only. A boundary limits what a
   role can do, not who can assume it.

When an app needs a new AWS service, the change goes into the boundary in
Template 1, and Ops reviews it.

```
GitHub Actions ──OIDC──▶ <app>-gh-deploy-<env>  (push image, run change sets, pass one role)
                                │ iam:PassRole
                                ▼
CloudFormation ──assumes──▶ <app>-cfn-exec       (resource permissions, scoped by name)
                                │ iam:CreateRole only with boundary
                                ▼
                         <app>-app-*  ≤  <app>-workload-boundary
```

## Baseline

These are defaults, not hard limits. To change one for a specific deployment,
edit the template and explain why in the pull request. Every default carries a
comment where it is set.

| Requirement | Where it is set | Checked by |
|---|---|---|
| Least-privilege roles | Every policy in `security.yaml`, scoped by ARN prefix | review |
| No `<service>:*` or `*` actions | All policies | `baseline.guard`: `iam_*_no_wildcard_actions` |
| CloudWatch/SSM-only instance role | `InstanceRole` in `security.yaml` | review (see open question 1) |
| No `0.0.0.0/0` security group ingress | `app.yaml`: load balancer accepts only the ingress prefix list | `sg_no_open_ingress`, plus a parameter pattern in `network.yaml` |
| NACL denies 22/tcp from `0.0.0.0/0` | `network.yaml`, rule 10 on every subnet | `nacl_denies_ssh` |
| NACL denies 3389/tcp from `0.0.0.0/0` | `network.yaml`, rule 20 on every subnet | `nacl_denies_rdp` |
| IMDSv2 required | `examples/ec2.yaml` (Fargate exposes no IMDS) | `ec2_imdsv2_required`, `ec2_instance_uses_launch_template` |
| EBS encryption | `examples/ec2.yaml` | `*_ebs_encrypted` |
| RDS/ElastiCache encryption | `examples/rds.yaml`, `examples/elasticache.yaml` | `rds_*`, `elasticache_*` |
| No public RDS/ElastiCache | Private subnets; access only from the task security group | `rds_instance_not_public` |

Also enforced: no IAM users or access keys, no public IPs on tasks, HTTP
listeners only redirect, images are deployed by digest, and production
promotes the image staging tested.

### Deliberate exceptions for reviewers

- **Egress to `0.0.0.0/0` on tcp/443.** The load balancer has to reach the
  identity provider, and the tasks have to reach ECR and the load balancer's
  signing-key endpoint. None of these have fixed IPs. All other egress is
  closed, and the guard rules allow `0.0.0.0/0` egress on 443 only.
- **NACL allow rules use `0.0.0.0/0`.** NACLs are stateless, so return traffic
  needs ports 1024 to 65535 open. The SSH and RDP denies are numbered lower, so
  they still win. Security groups do the real filtering.
- **`Resource: "*"`** appears only for actions that have no resource-level
  support (Describe calls, `ecr:GetAuthorizationToken`, EC2 create calls). Each
  one has a comment. Next tightening step: require the `aws:ResourceTag/app`
  tag on EC2 modify and delete actions.

## Setting up a new app

### One-time setup by Ops, per account

1. Create the GitHub OIDC provider, or let the first app's `security.yaml` do it
   with `CreateGitHubOidcProvider=true`.
2. Create a role that can deploy `<app>-security` stacks. It must trust only
   `repo:<org>/<repo>:environment:security`. Do not define this role in this
   repo, so the repo can never widen its own permissions.
3. Turn on EBS encryption by default for the account and region.
4. Protect `*-instance` roles from changes by admins (an SCP or an explicit
   Deny). A template cannot do this.

### Per app

1. Fill in [`security/config.json`](security/config.json) and
   [`app/config.json`](app/config.json). A deploy fails while any value is
   still `REPLACE_ME`.
2. In GitHub, create three environments:
   - `security`: required reviewers from Ops, and the variable
     `SECURITY_DEPLOY_ROLE_ARN`.
   - `staging`: the secret `OIDC_CLIENT_SECRET`.
   - `production`: required reviewers, and the secret `OIDC_CLIENT_SECRET`.
3. Protect `main`: require pull requests, the **Checks** workflow, and review
   from Code Owners.
4. Merge. **Security stack** runs and waits for Ops approval.
5. Run **Set OIDC client secret** once for `staging` and once for `production`.
6. Run **Deploy**. It deploys staging, then waits for approval to promote to
   production.

Register `https://<DomainName>/oauth2/idpresponse` as the callback URL for the
OIDC client.

## Layout

```
infra/
  security/security.yaml   Template 1
  security/config.json     its parameters
  app/network.yaml         Template 2: VPC, subnets, NAT, NACLs, ingress list
  app/app.yaml             Template 2: load balancer + OIDC, ECS, cert, DNS, task role
  app/config.json          per-environment parameters
  app/examples/            RDS, ElastiCache, EC2 with the baseline defaults
  guard/baseline.guard     rules for every template
  guard/app.guard          extra rules for Template 2
.github/
  workflows/ci.yml         lint, tests, cfn-lint, cfn-guard (every PR)
  workflows/deploy.yml     Template 2: build once, staging, then production
  workflows/security-stack.yml   Template 1, behind Ops approval
  workflows/set-oidc-secret.yml  copies the login secret into Secrets Manager
  actions/deploy-env/      shared deploy steps for one environment
  CODEOWNERS
```

## Open questions for Ops

1. **"CW/SSM-only role based off Prod, unable to be modified by admin users."**
   This is implemented as the `InstanceRole`: an EC2 role with only
   CloudWatch and SSM managed policies, which replaces SSH and RDP. Is that the
   intent? Is there an existing production role it should copy? The "cannot be
   modified by admins" part needs an SCP; see Ops setup step 4.
2. **Shared or per-app load balancer.** Each app currently gets its own load
   balancer and network, so its stacks are self-contained. A shared one is
   cheaper with many tools, but every app's deploy would then change the
   shared listener.
3. **New AWS services.** The examples need `rds`, `elasticache` or EC2
   instance permissions added to `<app>-cfn-exec` and to the boundary. Should
   each app request those as needed, or should the template include a
   standard set?
