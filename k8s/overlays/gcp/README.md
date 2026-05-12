# GCP-specific overlay — adds Cloud SQL Auth Proxy sidecar
# and Workload Identity annotation to the workspace template
#
# Usage:
#   WORKSPACE_ID=dev WORKSPACE_NAME=Development \
#     envsubst < k8s/base/workspace.yaml > /tmp/ws.yaml && \
#     kubectl apply -f /tmp/ws.yaml && \
#     kubectl patch statefulset rt-dev --type=json \
#       -p "$(cat k8s/overlays/gcp/cloudsql-patch.json)"
#
# Or just use: ./deploy-gke.sh dev Development
---
# Patch to add Cloud SQL proxy sidecar to any workspace StatefulSet
# Apply with: kubectl patch statefulset rt-<id> --type=json -p @cloudsql-patch.json
