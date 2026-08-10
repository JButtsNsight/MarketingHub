#!/usr/bin/env bash
# =============================================================================
# deploy-preview.sh — the CANONICAL MarketingHub PREVIEW deploy (runbook §3–§4)
#
# This script ends the out-of-band task-def era: every deploy goes through
# `cdk deploy MarketingHubApp` with the FULL live-derived context, so cdk owns
# the task definitions again and nothing that is live can be silently stripped.
# The old /tmp/deploy-w1.sh path (register-task-definition + update-service
# out-of-band) is SUPERSEDED — it is exactly what created the drift.
#
# Invoke deliberately (typed confirm; pipeable):
#   echo DEPLOY-PREVIEW | bash app-infra/scripts/deploy-preview.sh [IMAGE_TAG]
#
# Arguments / knobs:
#   $1 (optional)         image tag to deploy; default parity-<HEAD short sha>.
#                         If the tag is absent from ECR it is built from HEAD
#                         (web/Dockerfile, linux/amd64) and pushed first —
#                         in that case the tag MUST be parity-<HEAD short sha>
#                         so tags never lie about their source commit.
#   SMS_LINK_BASE_URL     (env, optional) overrides the smsLinkBaseUrl context;
#                         otherwise the LIVE task-def value is kept
#                         (default http://localhost:8080 when absent live).
#   SUPABASE_DIFF_STACKS  (env, optional) space-separated Supabase stacks for
#                         the REPORT-ONLY post-deploy drift diff
#                         (default "SupabaseData"; never deployed here).
#
# What it does, in order:
#   1. Preflight: clean tree on a branch, account 439024109088, tools present.
#   2. Resolves the image tag and whether it already exists in ECR.
#   3. Derives EVERY cdk context value from LIVE state (never from notes):
#      supabaseUrl from the SupabaseHostPrivateIp CFN export; VPC/subnets/SGs
#      from the live service's awsvpc config (cross-checked against the
#      Supabase CFN exports); secret complete-ARNs + CMKs via describe-secret;
#      headlessClaudeUrl from the gateway secret's base_url; the worker image
#      PINNED to its own live image (app/worker drifted apart — the single
#      dispatcher is never rolled onto the app's build); posture flags
#      (enableRealtimeAlb, app-config secrets, gateway key, Bedrock) read from
#      the live stack/task-def so this script never flips a wave on or off.
#   4. SAFETY GATE (the no-silent-strip guarantee): `cdk synth` with the full
#      context, then machine-compare the synthesized app + worker container
#      definitions against the LIVE task-defs (via the services). The synth
#      MUST carry every env var name and every secret name that is live, plus
#      the intended images — HEADLESS_CLAUDE_URL / HEADLESS_CLAUDE_API_KEY /
#      SUPABASE_JWT_SECRET are the crown jewels. A readable diff is printed;
#      anything live that would be lost ABORTS before any mutation.
#   5. Typed DEPLOY-PREVIEW confirm (after the printed plan + cdk diff).
#   6. Image: if absent from ECR — fresh ECR login (the 12h-login 403 gotcha),
#      buildx linux/amd64 --push, then VERIFY the tag actually landed with
#      describe-images (pipefail; a masked push failure cannot slip through).
#   7. `cdk deploy MarketingHubApp --require-approval never` (the typed
#      confirm after the printed diff IS the approval; cdk's own TTY prompt
#      cannot be answered in non-interactive runs and strands changesets).
#   8. Waits services-stable for BOTH services, re-verifies the new live
#      task-defs still carry every pre-deploy env+secret name and the right
#      images, prints old→new revisions + rollback one-liners.
#   9. REPORT-ONLY `cdk diff` of the Supabase stacks (default SupabaseData) so
#      remaining infra drift is visible. Never deploys them.
#
# Secret hygiene: secret VALUES are never printed — only names, ARNs and the
# non-secret base_url. JSON-key presence is checked with jq -e has(...).
# =============================================================================
set -euo pipefail
export AWS_PAGER=""

REGION=us-east-1
ACCT=439024109088
STACK=MarketingHubApp
ECR_REPO=marketinghub-app
ECR_HOST="$ACCT.dkr.ecr.$REGION.amazonaws.com"
CONFIRM_WORD=DEPLOY-PREVIEW

SERVICE_ROLE_SECRET_ID=nsight-supabase/service-role
SMS_SECRET_ID=marketinghub/sms-campaigns
GATEWAY_SECRET_ID=marketinghub/headless-claude
APP_CONFIG_SECRET_ID=nsight-supabase/app-config
HOST_IP_EXPORT=SupabaseHostPrivateIp

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
APP_INFRA_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd -- "$APP_INFRA_DIR/.." && pwd)
WEB_DIR="$REPO_ROOT/web"
SUPABASE_CDK_DIR="$REPO_ROOT/cdk"

WORK=$(mktemp -d /tmp/deploy-preview.XXXXXX)

fail() {
  echo "!! $*" >&2
  echo ">> aborted (no changes made unless noted above); working files kept in $WORK" >&2
  exit 1
}

echo "== [1/9] preflight: tools, account, clean tree ============================"
command -v aws >/dev/null || fail "aws cli is required"
command -v jq >/dev/null || fail "jq is required"
command -v git >/dev/null || fail "git is required"
command -v docker >/dev/null || fail "docker is required"
docker buildx version >/dev/null 2>&1 || fail "docker buildx is required (linux/amd64 cross-build)"
command -v npx >/dev/null || fail "node/npx is required"
[ -x "$APP_INFRA_DIR/node_modules/.bin/cdk" ] \
  || fail "no local cdk in $APP_INFRA_DIR/node_modules — run: (cd $APP_INFRA_DIR && npm install)"

CALLER_ACCT=$(aws sts get-caller-identity --query Account --output text)
[ "$CALLER_ACCT" = "$ACCT" ] || fail "wrong AWS account: $CALLER_ACCT (expected $ACCT)"

BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)
[ "$BRANCH" != "HEAD" ] || fail "detached HEAD — check out a branch first"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  fail "working tree is not clean — commit or stash first (the image tag derives from HEAD; a dirty tree makes parity-<sha> a lie)"
fi
echo ">> branch=$BRANCH (clean), account=$ACCT, tools OK"

echo "== [2/9] resolve the image tag ============================================"
HEAD_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
IMAGE_TAG="${1:-parity-$HEAD_SHA}"
IMG="$ECR_HOST/$ECR_REPO:$IMAGE_TAG"
if aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$IMAGE_TAG" \
    --region "$REGION" >/dev/null 2>&1; then
  IMAGE_IN_ECR=1
  echo ">> image $IMG already in ECR — no build needed"
else
  IMAGE_IN_ECR=0
  # A tag that does not exist yet can only be built from HEAD — so it must BE
  # HEAD's tag. Deploying an older build = pass its (existing) tag as \$1.
  [ "$IMAGE_TAG" = "parity-$HEAD_SHA" ] \
    || fail "tag '$IMAGE_TAG' is not in ECR and is not parity-$HEAD_SHA — a fresh build is always tagged from HEAD; pass an EXISTING tag to deploy an older build"
  echo ">> image $IMG not in ECR — will buildx from web/Dockerfile after the confirm"
fi

echo "== [3/9] discover the live cluster / services / task-defs ================"
CLUSTER=$(aws ecs list-clusters --region "$REGION" \
  --query "clusterArns[?contains(@,'MarketingHubApp')]|[0]" --output text)
{ [ -n "$CLUSTER" ] && [ "$CLUSTER" != "None" ]; } || fail "no MarketingHubApp ECS cluster found"
APP_SERVICE=$(aws ecs list-services --cluster "$CLUSTER" --region "$REGION" \
  --query "serviceArns[?contains(@,'AppService')]|[0]" --output text)
{ [ -n "$APP_SERVICE" ] && [ "$APP_SERVICE" != "None" ]; } || fail "no AppService on $CLUSTER"
WORKER_SERVICE=$(aws ecs list-services --cluster "$CLUSTER" --region "$REGION" \
  --query "serviceArns[?contains(@,'WorkerService')]|[0]" --output text)
{ [ -n "$WORKER_SERVICE" ] && [ "$WORKER_SERVICE" != "None" ]; } \
  || fail "no WorkerService on $CLUSTER — cannot pin the live worker image (refusing to let cdk roll the dispatcher blind)"
echo ">> cluster=$CLUSTER"

aws ecs describe-services --cluster "$CLUSTER" --services "$APP_SERVICE" --region "$REGION" \
  --query 'services[0]' --output json > "$WORK/app-svc.json"
APP_TD_ARN=$(jq -r .taskDefinition "$WORK/app-svc.json")
aws ecs describe-task-definition --task-definition "$APP_TD_ARN" --region "$REGION" \
  --query taskDefinition --output json > "$WORK/app-td.json"
WORKER_TD_ARN=$(aws ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SERVICE" \
  --region "$REGION" --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition --task-definition "$WORKER_TD_ARN" --region "$REGION" \
  --query taskDefinition --output json > "$WORK/worker-td.json"
echo ">> live app    task-def: $APP_TD_ARN"
echo ">> live worker task-def: $WORKER_TD_ARN"

jq '[.containerDefinitions[] | select(.name=="app")][0]' "$WORK/app-td.json" > "$WORK/live-app-container.json"
jq '[.containerDefinitions[] | select(.name=="worker")][0]' "$WORK/worker-td.json" > "$WORK/live-worker-container.json"
[ "$(jq 'type' "$WORK/live-app-container.json")" = '"object"' ] || fail "no 'app' container in the live app task-def"
[ "$(jq 'type' "$WORK/live-worker-container.json")" = '"object"' ] || fail "no 'worker' container in the live worker task-def"

# Preview-only sanity: this script targets the INTERNAL preview stack.
ALB_SG=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::SecurityGroup' && starts_with(LogicalResourceId,'AlbSg')].PhysicalResourceId" \
  --output text)
{ [ -n "$ALB_SG" ] && [ "$ALB_SG" != "None" ]; } || fail "could not resolve the $STACK AlbSg"
ALB_SCHEME=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --query "LoadBalancers[?contains(SecurityGroups, '$ALB_SG')].Scheme | [0]" --output text)
[ "$ALB_SCHEME" = "internal" ] \
  || fail "ALB scheme is '$ALB_SCHEME', not 'internal' — this script targets the PREVIEW stack only (previewMode=true)"

echo "== [4/9] derive ALL cdk context from LIVE state ==========================="
# --- images ------------------------------------------------------------------
OLD_APP_IMAGE=$(jq -r '.image' "$WORK/live-app-container.json")
WORKER_IMG=$(jq -r '.image' "$WORK/live-worker-container.json")
echo "$WORKER_IMG" | grep -q '\.dkr\.ecr\.' || fail "live worker image '$WORKER_IMG' is not an ECR image — task-def shape changed"
if [ "$WORKER_IMG" != "$IMG" ]; then
  echo ">> worker PINNED to its live image (app/worker have drifted apart — expected):"
  echo ">>   app    -> $IMG (this deploy)"
  echo ">>   worker -> $WORKER_IMG (unchanged)"
fi

# --- supabaseUrl: from the CFN export, cross-checked against the live env ----
HOST_IP=$(aws cloudformation list-exports --region "$REGION" \
  --query "Exports[?Name=='$HOST_IP_EXPORT'].Value | [0]" --output text)
{ [ -n "$HOST_IP" ] && [ "$HOST_IP" != "None" ]; } || fail "CFN export $HOST_IP_EXPORT not found"
printf '%s' "$HOST_IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' \
  || fail "$HOST_IP_EXPORT export '$HOST_IP' is not an IPv4 address"
SUPA_URL="http://$HOST_IP:8000"
LIVE_SUPA_URL=$(jq -r '[.environment[]? | select(.name=="SUPABASE_URL") | .value][0] // ""' "$WORK/live-app-container.json")
[ "$LIVE_SUPA_URL" = "$SUPA_URL" ] \
  || fail "live SUPABASE_URL='$LIVE_SUPA_URL' != export-derived '$SUPA_URL' — the host moved or the task-def drifted; investigate before deploying"

# --- smsLinkBaseUrl: operator override > live value > default ----------------
LIVE_SMS_LINK=$(jq -r '[.environment[]? | select(.name=="SMS_LINK_BASE_URL") | .value][0] // ""' "$WORK/live-app-container.json")
if [ -n "${SMS_LINK_BASE_URL:-}" ]; then
  SMS_LINK="$SMS_LINK_BASE_URL"; SMS_LINK_SRC="operator override (env)"
elif [ -n "$LIVE_SMS_LINK" ]; then
  SMS_LINK="$LIVE_SMS_LINK"; SMS_LINK_SRC="live task-def"
else
  SMS_LINK="http://localhost:8080"; SMS_LINK_SRC="default"
fi

# --- service-role + sms secrets: complete ARNs + the shared CMK --------------
SRS_ARN=$(aws secretsmanager describe-secret --secret-id "$SERVICE_ROLE_SECRET_ID" \
  --region "$REGION" --query ARN --output text)
SRS_KMS_ID=$(aws secretsmanager describe-secret --secret-id "$SERVICE_ROLE_SECRET_ID" \
  --region "$REGION" --query KmsKeyId --output text)
SRS_KMS_ARN=$(aws kms describe-key --key-id "$SRS_KMS_ID" --region "$REGION" \
  --query KeyMetadata.Arn --output text)
LIVE_SRS_FROM=$(jq -r '[.secrets[]? | select(.name=="SUPABASE_SERVICE_ROLE_KEY") | .valueFrom][0] // ""' "$WORK/live-app-container.json")
[ "$LIVE_SRS_FROM" = "$SRS_ARN:SERVICE_ROLE_KEY::" ] \
  || fail "live SUPABASE_SERVICE_ROLE_KEY valueFrom '$LIVE_SRS_FROM' does not match $SERVICE_ROLE_SECRET_ID '$SRS_ARN' — investigate"

SMS_ARN=$(aws secretsmanager describe-secret --secret-id "$SMS_SECRET_ID" \
  --region "$REGION" --query ARN --output text)
LIVE_SMS_FROM=$(jq -r '[.secrets[]? | select(.name=="MONDAY_API_TOKEN") | .valueFrom][0] // ""' "$WORK/live-app-container.json")
[ "$LIVE_SMS_FROM" = "$SMS_ARN:MONDAY_API_TOKEN::" ] \
  || fail "live MONDAY_API_TOKEN valueFrom '$LIVE_SMS_FROM' does not match $SMS_SECRET_ID '$SMS_ARN' — investigate"

# --- posture flags: read from live, NEVER flipped by this script -------------
# W5 realtime: flag ON iff the stack already has the RealtimeTargetGroup.
REALTIME_COUNT=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "length(StackResources[?ResourceType=='AWS::ElasticLoadBalancingV2::TargetGroup' && contains(LogicalResourceId,'RealtimeTargetGroup')])" \
  --output text)
if [ "$REALTIME_COUNT" != "0" ]; then ENABLE_REALTIME=true; else ENABLE_REALTIME=false; fi

# W4/W5/W6 app-config secrets: context passed iff live already carries them.
# This script NEVER turns W4 ON (that is /tmp/deploy-w5-infra.sh, which hard-
# gates on the RLS migration) and never strips it (the [5/9] gate would abort).
AC_ARN=""; AC_KMS_ARN=""
HAS_JWT=$(jq '[.secrets[]? | select(.name=="SUPABASE_JWT_SECRET")] | length' "$WORK/live-app-container.json")
if [ "$HAS_JWT" != "0" ]; then
  AC_ARN=$(aws secretsmanager describe-secret --secret-id "$APP_CONFIG_SECRET_ID" \
    --region "$REGION" --query ARN --output text)
  AC_KMS_ID=$(aws secretsmanager describe-secret --secret-id "$APP_CONFIG_SECRET_ID" \
    --region "$REGION" --query KmsKeyId --output text)
  AC_KMS_ARN=$(aws kms describe-key --key-id "$AC_KMS_ID" --region "$REGION" \
    --query KeyMetadata.Arn --output text)
  LIVE_JWT_FROM=$(jq -r '[.secrets[]? | select(.name=="SUPABASE_JWT_SECRET") | .valueFrom][0] // ""' "$WORK/live-app-container.json")
  [ "$LIVE_JWT_FROM" = "$AC_ARN:JWT_SECRET::" ] \
    || fail "live SUPABASE_JWT_SECRET valueFrom '$LIVE_JWT_FROM' does not match $APP_CONFIG_SECRET_ID '$AC_ARN' — investigate"
  # All three JSON keys must exist or the new tasks fail start
  # (ResourceInitializationError) and the circuit breaker rolls back.
  # Presence-only check — values are NEVER printed.
  AC_KEYS=$(aws secretsmanager get-secret-value --secret-id "$AC_ARN" --region "$REGION" \
    --query SecretString --output text)
  printf '%s' "$AC_KEYS" | jq -e 'has("JWT_SECRET") and has("ANON_KEY") and has("LOGFLARE_PRIVATE_ACCESS_TOKEN")' >/dev/null \
    || fail "$APP_CONFIG_SECRET_ID is missing one of JWT_SECRET / ANON_KEY / LOGFLARE_PRIVATE_ACCESS_TOKEN"
  unset AC_KEYS
  echo ">> app-config secrets live -> context passed (JWT/ANON/LOGFLARE keys verified present; values not displayed)"
else
  echo ">> live task-def carries NO SUPABASE_JWT_SECRET — app-config context omitted (W4 posture unchanged)"
fi

# W8R gateway: context passed iff live already carries BOTH vars.
GW_ARN=""; GW_URL=""
HAS_GW_KEY=$(jq '[.secrets[]? | select(.name=="HEADLESS_CLAUDE_API_KEY")] | length' "$WORK/live-app-container.json")
HAS_GW_URL=$(jq '[.environment[]? | select(.name=="HEADLESS_CLAUDE_URL")] | length' "$WORK/live-app-container.json")
if [ "$HAS_GW_KEY" != "0" ] && [ "$HAS_GW_URL" != "0" ]; then
  GW_ARN=$(aws secretsmanager describe-secret --secret-id "$GATEWAY_SECRET_ID" \
    --region "$REGION" --query ARN --output text)
  GW_KMS_ID=$(aws secretsmanager describe-secret --secret-id "$GATEWAY_SECRET_ID" \
    --region "$REGION" --query KmsKeyId --output text)
  GW_KMS_ARN=$(aws kms describe-key --key-id "$GW_KMS_ID" --region "$REGION" \
    --query KeyMetadata.Arn --output text)
  # The stack adds NO kms grant for this secret — it relies on the existing
  # kms:Decrypt on the service-role/sms CMK. If the CMK ever drifts apart the
  # new tasks fail start, so abort here instead.
  [ "$GW_KMS_ARN" = "$SRS_KMS_ARN" ] \
    || fail "$GATEWAY_SECRET_ID CMK ($GW_KMS_ARN) != service-role/sms CMK ($SRS_KMS_ARN) — app-stack.ts relies on the shared-CMK grant; re-provision the secret under the shared CMK first"
  LIVE_GW_FROM=$(jq -r '[.secrets[]? | select(.name=="HEADLESS_CLAUDE_API_KEY") | .valueFrom][0] // ""' "$WORK/live-app-container.json")
  [ "$LIVE_GW_FROM" = "$GW_ARN:api_key::" ] \
    || fail "live HEADLESS_CLAUDE_API_KEY valueFrom '$LIVE_GW_FROM' does not match $GATEWAY_SECRET_ID '$GW_ARN' — investigate"
  # base_url: the secret is the single source of truth (never hardcoded here).
  GW_JSON=$(aws secretsmanager get-secret-value --secret-id "$GW_ARN" --region "$REGION" \
    --query SecretString --output text)
  printf '%s' "$GW_JSON" | jq -e 'has("api_key") and (.api_key | length > 0)' >/dev/null \
    || fail "$GATEWAY_SECRET_ID has no api_key — run /tmp/provision-intel-gateway-key.sh"
  GW_URL=$(printf '%s' "$GW_JSON" | jq -r '.base_url // ""')
  unset GW_JSON
  GW_URL=${GW_URL%/}
  case "$GW_URL" in
    https://*) : ;;
    *) fail "$GATEWAY_SECRET_ID base_url ('$GW_URL') is not an https URL — refusing to deploy it" ;;
  esac
  LIVE_GW_URL=$(jq -r '[.environment[]? | select(.name=="HEADLESS_CLAUDE_URL") | .value][0] // ""' "$WORK/live-app-container.json")
  [ "$LIVE_GW_URL" = "$GW_URL" ] \
    || fail "live HEADLESS_CLAUDE_URL='$LIVE_GW_URL' != secret base_url='$GW_URL' — stale staging (the secret changed after the env was staged); reconcile before deploying"
  echo ">> gateway env live -> context passed (api_key present, value not displayed; base_url=$GW_URL)"
elif [ "$HAS_GW_KEY" != "0" ] || [ "$HAS_GW_URL" != "0" ]; then
  fail "PARTIAL gateway staging on the live task-def (url=$HAS_GW_URL key=$HAS_GW_KEY) — investigate before deploying"
else
  echo ">> no gateway env live — headlessClaude* context omitted (intel stays keyword-only)"
fi

# W8 Bedrock embeddings: flag ON iff live env says so (permanently skipped as
# of 2026-08-10, so this normally stays off — posture-preserving either way).
LIVE_CI_PROVIDER=$(jq -r '[.environment[]? | select(.name=="CI_EMBED_PROVIDER") | .value][0] // ""' "$WORK/live-app-container.json")

# Worker-only OPTIONAL envs: pass through whatever is live so nothing strips.
LIVE_ST_PHONE=$(jq -r '[.environment[]? | select(.name=="SIMPLETEXTING_ACCOUNT_PHONE") | .value][0] // ""' "$WORK/live-worker-container.json")
LIVE_CAP_COUNT=$(jq -r '[.environment[]? | select(.name=="SMS_FREQ_CAP_COUNT") | .value][0] // ""' "$WORK/live-worker-container.json")
LIVE_CAP_DAYS=$(jq -r '[.environment[]? | select(.name=="SMS_FREQ_CAP_DAYS") | .value][0] // ""' "$WORK/live-worker-container.json")

# --- network: from the live service's awsvpc config (deploy-w5 derivation),
# --- cross-checked against the Supabase CFN exports ---------------------------
SUBNET_IDS_RAW=$(jq -r '.networkConfiguration.awsvpcConfiguration.subnets | join(" ")' "$WORK/app-svc.json")
read -ra SUBNET_ARR <<<"$SUBNET_IDS_RAW"
aws ec2 describe-subnets --region "$REGION" --subnet-ids "${SUBNET_ARR[@]}" \
  --query 'Subnets[].{Id:SubnetId,Az:AvailabilityZone,Vpc:VpcId}' --output json > "$WORK/subnets.json"
VPC_ID=$(jq -r '[.[].Vpc] | unique | .[0]' "$WORK/subnets.json")
[ "$(jq -r '[.[].Vpc] | unique | length' "$WORK/subnets.json")" = "1" ] || fail "service subnets span multiple VPCs?"
AZS=$(jq -r '[.[].Az] | unique | sort | join(",")' "$WORK/subnets.json")
SUBNETS=$(jq -r 'sort_by(.Az) | [.[].Id] | join(",")' "$WORK/subnets.json")
SERVICE_SG=$(aws cloudformation describe-stack-resources --stack-name "$STACK" --region "$REGION" \
  --query "StackResources[?ResourceType=='AWS::EC2::SecurityGroup' && starts_with(LogicalResourceId,'ServiceSg')].PhysicalResourceId" \
  --output text)
{ [ -n "$SERVICE_SG" ] && [ "$SERVICE_SG" != "None" ]; } || fail "could not resolve the $STACK ServiceSg"
INTERNAL_SG=$(jq -r --arg own "$SERVICE_SG" \
  '.networkConfiguration.awsvpcConfiguration.securityGroups[] | select(. != $own)' "$WORK/app-svc.json")
[ "$(printf '%s\n' "$INTERNAL_SG" | wc -l | tr -d ' ')" = "1" ] \
  || fail "could not isolate the internalClientSg from the live service's SGs"

EXPORT_VPC=$(aws cloudformation list-exports --region "$REGION" \
  --query "Exports[?Name=='SupabaseVpcId'].Value | [0]" --output text)
EXPORT_SG=$(aws cloudformation list-exports --region "$REGION" \
  --query "Exports[?Name=='SupabaseInternalClientSgId'].Value | [0]" --output text)
[ "$EXPORT_VPC" = "None" ] || [ "$EXPORT_VPC" = "$VPC_ID" ] \
  || fail "live service VPC $VPC_ID != SupabaseVpcId export $EXPORT_VPC — investigate"
[ "$EXPORT_SG" = "None" ] || [ "$EXPORT_SG" = "$INTERNAL_SG" ] \
  || fail "derived internalClientSg $INTERNAL_SG != SupabaseInternalClientSgId export $EXPORT_SG — investigate"
echo ">> vpc=$VPC_ID azs=$AZS"
echo ">> subnets=$SUBNETS"
echo ">> internalClientSg=$INTERNAL_SG (cross-checked against the CFN export)"

# --- assemble the full context ------------------------------------------------
CDK_CTX=(
  -c previewMode=true
  -c appImageTag="$IMG"
  -c workerImageTag="$WORKER_IMG"
  -c supabaseUrl="$SUPA_URL"
  -c smsLinkBaseUrl="$SMS_LINK"
  -c supabaseServiceRoleSecretArn="$SRS_ARN"
  -c supabaseSecretsKmsKeyArn="$SRS_KMS_ARN"
  -c smsSecretsArn="$SMS_ARN"
  -c supabaseVpcId="$VPC_ID"
  -c supabaseVpcAzs="$AZS"
  -c supabasePrivateSubnetIds="$SUBNETS"
  -c supabaseInternalClientSgId="$INTERNAL_SG"
)
if [ "$ENABLE_REALTIME" = true ]; then
  CDK_CTX+=( -c enableRealtimeAlb=true )
fi
if [ -n "$AC_ARN" ]; then
  CDK_CTX+=( -c supabaseAppConfigSecretArn="$AC_ARN" -c supabaseAppConfigKmsKeyArn="$AC_KMS_ARN" )
fi
if [ -n "$GW_ARN" ]; then
  CDK_CTX+=( -c headlessClaudeUrl="$GW_URL" -c headlessClaudeApiKeySecretArn="$GW_ARN" )
fi
if [ "$LIVE_CI_PROVIDER" = "bedrock" ]; then
  CDK_CTX+=( -c enableBedrockEmbeddings=true )
fi
if [ -n "$LIVE_ST_PHONE" ]; then
  CDK_CTX+=( -c simpletextingAccountPhone="$LIVE_ST_PHONE" )
fi
if [ -n "$LIVE_CAP_COUNT" ]; then
  CDK_CTX+=( -c smsFreqCapCount="$LIVE_CAP_COUNT" )
fi
if [ -n "$LIVE_CAP_DAYS" ]; then
  CDK_CTX+=( -c smsFreqCapDays="$LIVE_CAP_DAYS" )
fi

echo "== [5/9] SAFETY GATE: synth vs LIVE task-defs (no-silent-strip) =========="
# stdin is protected (</dev/null) on every foreign command so the piped
# confirm word survives until the read below.
( cd "$APP_INFRA_DIR" && npx --no-install cdk synth "$STACK" "${CDK_CTX[@]}" --quiet -o "$WORK/synth" ) </dev/null
TPL="$WORK/synth/$STACK.template.json"
[ -f "$TPL" ] || fail "cdk synth produced no $STACK.template.json"

jq '[.Resources[] | select(.Type=="AWS::ECS::TaskDefinition") | .Properties.ContainerDefinitions[]? | select(.Name=="app")][0]' \
  "$TPL" > "$WORK/synth-app-container.json"
jq '[.Resources[] | select(.Type=="AWS::ECS::TaskDefinition") | .Properties.ContainerDefinitions[]? | select(.Name=="worker")][0]' \
  "$TPL" > "$WORK/synth-worker-container.json"
[ "$(jq 'type' "$WORK/synth-app-container.json")" = '"object"' ] || fail "no 'app' container in the synthesized template"
[ "$(jq 'type' "$WORK/synth-worker-container.json")" = '"object"' ] || fail "no 'worker' container in the synthesized template"

# live (lowercase keys) vs synth (CFN PascalCase keys); names are the gate,
# value/ref changes are printed for review (env values + valueFrom ARNs are
# not secret material — secret VALUES never appear in a task definition).
gate_report() { # $1=live-container-file $2=synth-container-file
  jq -n --slurpfile L "$1" --slurpfile S "$2" '
    ($L[0]) as $l | ($S[0]) as $s |
    {
      live_image: $l.image,
      synth_image: (if ($s.Image | type) == "string" then $s.Image else ($s.Image | tojson) end),
      missing_env:     ((($l.environment // []) | map(.name)) - (($s.Environment // []) | map(.Name))),
      missing_secrets: ((($l.secrets // []) | map(.name)) - (($s.Secrets // []) | map(.Name))),
      added_env:       ((($s.Environment // []) | map(.Name)) - (($l.environment // []) | map(.name))),
      added_secrets:   ((($s.Secrets // []) | map(.Name)) - (($l.secrets // []) | map(.name))),
      changed_env: [ ($l.environment // [])[] as $e
        | ((($s.Environment // [])[] | select(.Name == $e.name)) // empty) as $m
        | select((($m.Value | type) == "string") and ($m.Value != $e.value))
        | { name: $e.name, live: $e.value, synth: $m.Value } ],
      changed_secret_refs: [ ($l.secrets // [])[] as $e
        | ((($s.Secrets // [])[] | select(.Name == $e.name)) // empty) as $m
        | select((($m.ValueFrom | type) == "string") and ($m.ValueFrom != $e.valueFrom))
        | { name: $e.name, live: $e.valueFrom, synth: $m.ValueFrom } ]
    }'
}
print_report() { # $1=label $2=report-json
  echo "  ---- $1 ----"
  jq -r '
    ( "    live image  : " + .live_image ),
    ( "    synth image : " + .synth_image ),
    ( if (.missing_env | length) > 0
      then "    !! MISSING ENV (live, absent from synth): " + (.missing_env | join(", "))
      else "    env: every live env name present in synth" end ),
    ( if (.missing_secrets | length) > 0
      then "    !! MISSING SECRETS (live, absent from synth): " + (.missing_secrets | join(", "))
      else "    secrets: every live secret name present in synth" end ),
    ( if (.added_env | length) > 0 then "    synth ADDS env: " + (.added_env | join(", ")) else empty end ),
    ( if (.added_secrets | length) > 0 then "    synth ADDS secrets: " + (.added_secrets | join(", ")) else empty end ),
    ( .changed_env[] | "    env value change  \(.name): \(.live) -> \(.synth)" ),
    ( .changed_secret_refs[] | "    secret ref change \(.name): \(.live) -> \(.synth)" )
  ' <<<"$2"
}

APP_REPORT=$(gate_report "$WORK/live-app-container.json" "$WORK/synth-app-container.json")
WORKER_REPORT=$(gate_report "$WORK/live-worker-container.json" "$WORK/synth-worker-container.json")
echo
print_report "app container (live $APP_TD_ARN)" "$APP_REPORT"
echo
print_report "worker container (live $WORKER_TD_ARN)" "$WORKER_REPORT"
echo

APP_LOSS=$(jq '.missing_env + .missing_secrets | length' <<<"$APP_REPORT")
WORKER_LOSS=$(jq '.missing_env + .missing_secrets | length' <<<"$WORKER_REPORT")
if [ "$APP_LOSS" != "0" ] || [ "$WORKER_LOSS" != "0" ]; then
  fail "NO-SILENT-STRIP GATE FAILED — the synthesized template would DROP live env/secrets (see MISSING lines above).
   Deploying would strip them from the task-defs (HEADLESS_CLAUDE_URL / HEADLESS_CLAUDE_API_KEY /
   SUPABASE_JWT_SECRET are the crown jewels — losing them silently degrades intel search or
   breaks auth). Someone staged new out-of-band env/secrets since this script was written:
   fold them into app-infra/lib/app-stack.ts (a context-flagged block, like the W5/W8R ones)
   and THIS script's context derivation, then re-run. NOTHING was deployed."
fi
SYNTH_APP_IMAGE=$(jq -r '.synth_image' <<<"$APP_REPORT")
SYNTH_WORKER_IMAGE=$(jq -r '.synth_image' <<<"$WORKER_REPORT")
[ "$SYNTH_APP_IMAGE" = "$IMG" ] \
  || fail "synth app image '$SYNTH_APP_IMAGE' != intended '$IMG' — context did not take; investigate"
[ "$SYNTH_WORKER_IMAGE" = "$WORKER_IMG" ] \
  || fail "synth worker image '$SYNTH_WORKER_IMAGE' != live worker pin '$WORKER_IMG' — the dispatcher would be rolled onto a different build; investigate"
echo ">> GATE PASS: synth carries every live env+secret name; app image = intended, worker image = live pin"

cat <<SUMMARY

  ---------------------------------------------------------------------------
  PREVIEW DEPLOY PLAN — everything below was derived LIVE just now
  ---------------------------------------------------------------------------
  stack                     $STACK  (previewMode=true, scheme=$ALB_SCHEME)
  appImageTag               $IMG$( [ "$IMAGE_IN_ECR" = "1" ] && printf ' (in ECR)' || printf ' (WILL BUILD+PUSH from HEAD %s)' "$HEAD_SHA" )
  workerImageTag     (live) $WORKER_IMG  (pinned — dispatcher never rolled)
  supabaseUrl      (export) $SUPA_URL
  smsLinkBaseUrl            $SMS_LINK  ($SMS_LINK_SRC)
  enableRealtimeAlb  (live) $ENABLE_REALTIME
  appConfig secret   (live) ${AC_ARN:-<omitted — not live>}
  appConfig CMK             ${AC_KMS_ARN:-<n/a>}
  serviceRoleSecret         $SRS_ARN
  serviceRole/sms CMK       $SRS_KMS_ARN
  smsSecrets                $SMS_ARN
  headlessClaude sec (live) ${GW_ARN:-<omitted — not live>}
  headlessClaudeUrl (secret) ${GW_URL:-<n/a>}
  vpc / azs                 $VPC_ID / $AZS
  subnets                   $SUBNETS
  internalClientSg          $INTERNAL_SG
  ---------------------------------------------------------------------------
  The cdk diff for exactly this context follows. READ IT. Expected surface on
  a routine image deploy: ~ AppTaskDef (image only) and CFN catching up with
  any out-of-band task-def revisions it lags behind (same names, new revision).
  A WorkerTaskDef diff showing a DIFFERENT image, or any dropped env/secret,
  or a service/target-group replacement = STOP.
  ---------------------------------------------------------------------------

SUMMARY

( cd "$APP_INFRA_DIR" && npx --no-install cdk diff "$STACK" "${CDK_CTX[@]}" ) </dev/null || true

echo
printf 'Type %s to %srun cdk deploy (anything else aborts): ' \
  "$CONFIRM_WORD" "$( [ "$IMAGE_IN_ECR" = "1" ] || printf 'build+push the image and ' )"
read -r REPLY
[ "$REPLY" = "$CONFIRM_WORD" ] || { echo ">> aborted (no changes made)"; exit 1; }

echo "== [6/9] ensure the image exists in ECR ==================================="
if [ "$IMAGE_IN_ECR" = "1" ]; then
  echo ">> $IMG already in ECR — skipping build"
else
  # Fresh login EVERY time: the cached ECR token expires after 12h and a stale
  # one 403s the push (pipefail makes a failed get-login-password abort here).
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$ECR_HOST"
  docker buildx build --platform linux/amd64 -f "$WEB_DIR/Dockerfile" \
    -t "$IMG" "$WEB_DIR" --push </dev/null
  # VERIFY the tag actually landed — a masked push failure must not reach deploy.
  aws ecr describe-images --repository-name "$ECR_REPO" --image-ids imageTag="$IMAGE_TAG" \
    --region "$REGION" --query 'imageDetails[0].{tag:imageTags[0],pushed:imagePushedAt,digest:imageDigest}' \
    --output json \
    || fail "image push did not land in ECR (describe-images can't find $IMAGE_TAG) — the 12h-ECR-login 403 gotcha or a masked buildx failure; NOTHING deployed"
fi

echo "== [7/9] cdk deploy ========================================================"
# --require-approval never: the typed confirm above, AFTER the printed diff,
# IS the approval (cdk's own TTY prompt strands an unexecuted changeset when
# stdin is not a TTY — the 2026-08-10 first-attempt lesson).
( cd "$APP_INFRA_DIR" && npx --no-install cdk deploy "$STACK" "${CDK_CTX[@]}" --require-approval never ) </dev/null

echo "== [8/9] wait for BOTH services, then verify nothing was lost ============="
STABLE=0
for ATTEMPT in 1 2 3; do
  if aws ecs wait services-stable --cluster "$CLUSTER" \
       --services "$APP_SERVICE" "$WORKER_SERVICE" --region "$REGION" </dev/null; then
    STABLE=1; break
  fi
  echo ">> services-stable attempt $ATTEMPT/3 timed out (~10 min each) — re-waiting"
done
[ "$STABLE" = "1" ] \
  || fail "services never stabilized — inspect: aws ecs describe-services --cluster $CLUSTER --services $APP_SERVICE $WORKER_SERVICE --region $REGION --query 'services[].deployments' (the circuit breaker may have rolled the app back)"

NEW_APP_TD=$(aws ecs describe-services --cluster "$CLUSTER" --services "$APP_SERVICE" \
  --region "$REGION" --query 'services[0].taskDefinition' --output text)
NEW_WORKER_TD=$(aws ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SERVICE" \
  --region "$REGION" --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition --task-definition "$NEW_APP_TD" --region "$REGION" \
  --query taskDefinition --output json > "$WORK/new-app-td.json"
aws ecs describe-task-definition --task-definition "$NEW_WORKER_TD" --region "$REGION" \
  --query taskDefinition --output json > "$WORK/new-worker-td.json"
jq '[.containerDefinitions[] | select(.name=="app")][0]' "$WORK/new-app-td.json" > "$WORK/new-app-container.json"
jq '[.containerDefinitions[] | select(.name=="worker")][0]' "$WORK/new-worker-td.json" > "$WORK/new-worker-container.json"

verify_kept() { # $1=old-container-file $2=new-container-file  -> prints lost names (empty = none)
  jq -rn --slurpfile O "$1" --slurpfile N "$2" '
    ((($O[0].environment // []) | map(.name)) - (($N[0].environment // []) | map(.name)))
    + ((($O[0].secrets // []) | map(.name)) - (($N[0].secrets // []) | map(.name)))
    | join(", ")'
}
APP_LOST=$(verify_kept "$WORK/live-app-container.json" "$WORK/new-app-container.json")
WORKER_LOST=$(verify_kept "$WORK/live-worker-container.json" "$WORK/new-worker-container.json")
[ -z "$APP_LOST" ] || fail "POST-DEPLOY CHECK FAILED: new app task-def lost: $APP_LOST — roll the service back to the previous revision ${APP_TD_ARN##*/}"
[ -z "$WORKER_LOST" ] || fail "POST-DEPLOY CHECK FAILED: new worker task-def lost: $WORKER_LOST — roll the service back to ${WORKER_TD_ARN##*/}"
NEW_APP_IMAGE=$(jq -r '.image' "$WORK/new-app-container.json")
NEW_WORKER_IMAGE=$(jq -r '.image' "$WORK/new-worker-container.json")
[ "$NEW_APP_IMAGE" = "$IMG" ] || fail "new live app image '$NEW_APP_IMAGE' != intended '$IMG' — the circuit breaker likely rolled back; inspect stopped tasks"
[ "$NEW_WORKER_IMAGE" = "$WORKER_IMG" ] || fail "new live worker image '$NEW_WORKER_IMAGE' != pinned '$WORKER_IMG'"

app_ref() { printf '%s' "${1##*/}"; }   # arn -> FAMILY:REV
OLD_APP_REF=$(app_ref "$APP_TD_ARN");       NEW_APP_REF=$(app_ref "$NEW_APP_TD")
OLD_WORKER_REF=$(app_ref "$WORKER_TD_ARN"); NEW_WORKER_REF=$(app_ref "$NEW_WORKER_TD")
OLD_APP_TAG=${OLD_APP_IMAGE##*:}
ALB_DNS=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --query "LoadBalancers[?contains(SecurityGroups, '$ALB_SG')].DNSName | [0]" --output text)

cat <<POST

==============================================================================
DEPLOY VERIFIED.
  app    task-def: $OLD_APP_REF -> $NEW_APP_REF   (image $IMG)
  worker task-def: $OLD_WORKER_REF -> $NEW_WORKER_REF   (image $WORKER_IMG, pinned)
  every pre-deploy env var + secret name is still on the new revisions.

ROLLBACK
  Clean (keeps cdk ownership — PREFERRED): re-run this script with the
  previous image tag:
    echo $CONFIRM_WORD | bash app-infra/scripts/deploy-preview.sh $OLD_APP_TAG
  Emergency ECS-level one-liners (fast, but re-creates out-of-band drift
  until the next script run folds it back in):
    aws ecs update-service --cluster $CLUSTER --service $APP_SERVICE \\
      --task-definition $OLD_APP_REF --region $REGION --force-new-deployment
    aws ecs update-service --cluster $CLUSTER --service $WORKER_SERVICE \\
      --task-definition $OLD_WORKER_REF --region $REGION --force-new-deployment

UI check (SSM tunnel; session dies on idle — just rerun):
  aws ssm start-session --target i-06a9f48d434cbebc7 \\
    --document-name AWS-StartPortForwardingSessionToRemoteHost \\
    --parameters host=$ALB_DNS,portNumber=80,localPortNumber=8080 \\
    --region $REGION
  then open http://localhost:8080
==============================================================================
POST

echo "== [9/9] REPORT-ONLY: remaining Supabase-stack drift (never deployed) ====="
DIFF_STACKS_STR=${SUPABASE_DIFF_STACKS:-SupabaseData}
read -ra DIFF_STACKS <<<"$DIFF_STACKS_STR"
if [ -x "$SUPABASE_CDK_DIR/node_modules/.bin/cdk" ]; then
  for S in "${DIFF_STACKS[@]}"; do
    echo ">> cdk diff $S (report-only; the live Supabase stacks are the PREVIEW profile)"
    ( cd "$SUPABASE_CDK_DIR" && npx --no-install cdk diff "$S" -c previewMode=true ) </dev/null \
      || echo ">> (diff for $S reported differences or failed — informational only, nothing was deployed)"
  done
else
  echo ">> skipped: no local cdk in $SUPABASE_CDK_DIR/node_modules (run npm install there to enable the drift report)"
fi

echo
echo ">> done. Working files (task-def snapshots, synth template): $WORK"
