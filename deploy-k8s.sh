#!/bin/bash
# deploy-k8s.sh — Deploy a Roundtable workspace to any Kubernetes cluster
# Works on GKE, EKS, AKS, or any k8s environment
#
# Usage:
#   ./deploy-k8s.sh <workspace-id> [workspace-name]
#
# Prerequisites:
#   1. kubectl configured and connected to your cluster
#   2. ConfigMap applied:    kubectl apply -f k8s/base/config.yaml
#   3. Secrets created:
#      kubectl create secret generic roundtable-secrets \
#        --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
#        --from-literal=DATABASE_URL="postgresql://user:pass@host:5432/roundtable"
#   4. Container image accessible from your cluster
#      (set ROUNDTABLE_IMAGE env var if not using default GCP registry)
#
# Examples:
#   ./deploy-k8s.sh dev Development
#   ROUNDTABLE_IMAGE=myregistry/roundtable:v1 ./deploy-k8s.sh backend "Backend Team"

set -euo pipefail

WORKSPACE_ID="${1:?Usage: $0 <workspace-id> [workspace-name]}"
WORKSPACE_NAME="${2:-$WORKSPACE_ID}"
NAMESPACE="${NAMESPACE:-default}"
ROUNDTABLE_IMAGE="${ROUNDTABLE_IMAGE:-us-central1-docker.pkg.dev/roundtable-public/roundtable/roundtable:latest}"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  Deploying workspace: ${WORKSPACE_ID}"
echo "║  Cluster: $(kubectl config current-context)"
echo "╚═══════════════════════════════════════════════════╝"

# Verify prerequisites
echo "→ Checking prerequisites..."
kubectl get configmap roundtable-config -n "${NAMESPACE}" >/dev/null 2>&1 || {
  echo "  ⚠ ConfigMap not found. Creating from template..."
  kubectl apply -f k8s/base/config.yaml -n "${NAMESPACE}"
}

kubectl get secret roundtable-secrets -n "${NAMESPACE}" >/dev/null 2>&1 || {
  echo ""
  echo "  ✗ Secret 'roundtable-secrets' not found."
  echo "  Create it first:"
  echo ""
  echo "    kubectl create secret generic roundtable-secrets \\"
  echo "      --from-literal=SESSION_SECRET=\$(openssl rand -hex 32) \\"
  echo "      --from-literal=DATABASE_URL=\"postgresql://user:pass@host:5432/roundtable\""
  echo ""
  exit 1
}

# Deploy workspace
echo "→ Deploying workspace StatefulSet..."
export WORKSPACE_ID WORKSPACE_NAME NAMESPACE ROUNDTABLE_IMAGE
envsubst < k8s/base/workspace.yaml | kubectl apply -f - -n "${NAMESPACE}"

# Wait for rollout
echo "→ Waiting for pod to be ready..."
kubectl rollout status statefulset/rt-${WORKSPACE_ID} -n "${NAMESPACE}" --timeout=120s 2>/dev/null || true

echo ""
echo "✅ Workspace deployed: ${WORKSPACE_ID}"
echo "   Internal URL: http://rt-${WORKSPACE_ID}.${NAMESPACE}.svc.cluster.local:3000"
echo ""
echo "To expose externally:"
echo "  1. Install nginx-ingress (if not already):"
echo "     kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml"
echo "  2. Add a rule to k8s/base/ingress.yaml and apply:"
echo "     kubectl apply -f k8s/base/ingress.yaml"
echo ""
echo "To check status:"
echo "  kubectl get pods -l workspace=${WORKSPACE_ID}"
echo "  kubectl logs -l workspace=${WORKSPACE_ID} -c roundtable --tail=20"
