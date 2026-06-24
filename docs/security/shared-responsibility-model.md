# Shared Responsibility Model

**Roundtable on Google Cloud Platform — Security Control Ownership**
**Version:** 1.0
**Effective Date:** May 2026

---

## 1. Overview

Roundtable runs on Google Cloud Platform (GCP), which operates under a shared responsibility model. This document maps security control ownership between GCP (the infrastructure provider) and Foxtrot Communications (the platform operator) for SOC 2 auditing purposes.

GCP maintains its own SOC 2 Type II report, which covers the controls listed under "GCP Responsibility." Foxtrot Communications' SOC 2 scope covers all controls listed under "Foxtrot Responsibility."

## 2. Infrastructure Layer

| Control | GCP Responsibility | Foxtrot Responsibility |
|---------|-------------------|----------------------|
| Physical data center security | ✅ Fully managed | — |
| Hardware and firmware integrity | ✅ Fully managed | — |
| Network backbone encryption | ✅ Encryption in transit between GCP data centers | — |
| Hypervisor and host OS security | ✅ Fully managed | — |
| GKE control plane (API server, etcd, scheduler) | ✅ Fully managed | — |
| GKE node OS patching | ✅ Managed upgrades | Ensure auto-upgrade is enabled |
| Cloud SQL engine patching | ✅ Managed maintenance windows | — |

## 3. Platform Layer (GKE / Kubernetes)

| Control | GCP Responsibility | Foxtrot Responsibility |
|---------|-------------------|----------------------|
| Kubernetes API authentication | ✅ IAM integration | ✅ Configure RBAC, limit cluster-admin access |
| Pod-to-pod networking | ✅ VPC networking | ✅ Define NetworkPolicies |
| Container image hosting | ✅ Artifact Registry infrastructure | ✅ Enable vulnerability scanning, use signed images |
| Workload Identity | ✅ Token issuance and IAM binding | ✅ Annotate service accounts, bind KSA ↔ GSA |
| Ingress and load balancing | ✅ Network load balancer | ✅ Configure nginx-ingress, TLS certificates |
| Secrets storage | ✅ etcd encryption at rest | ✅ Manage K8s Secrets and GCP Secret Manager |

## 4. Data Layer

| Control | GCP Responsibility | Foxtrot Responsibility |
|---------|-------------------|----------------------|
| Cloud SQL encryption at rest | ✅ AES-256 by default | — |
| Cloud SQL encryption in transit | ✅ TLS between client and server | ✅ Configure connection strings |
| Cloud SQL automated backups | ✅ Infrastructure for backups | ✅ Verify backup schedule, test restores |
| Cloud SQL access control | ✅ IAM and authorized networks | ✅ Manage authorized network list, DB credentials |
| Firestore encryption | ✅ AES-256 by default | — |
| Firestore access rules | ✅ Security rules engine | ✅ Define and maintain security rules |
| Data isolation between tenants | — | ✅ Per-workspace database and pod isolation |

## 5. Identity and Access Management

| Control | GCP Responsibility | Foxtrot Responsibility |
|---------|-------------------|----------------------|
| Google Account MFA | ✅ Google enforces MFA on accounts | ✅ Require Google SSO (no password-based auth) |
| Firebase Authentication | ✅ Auth infrastructure | ✅ Configure providers, manage user lifecycle |
| GCP IAM policies | ✅ Policy enforcement engine | ✅ Define least-privilege roles and bindings |
| Service account key rotation | ✅ Key generation and revocation | ✅ Rotate keys, prefer Workload Identity over static keys |
| Dashboard RBAC (Owner/Admin/Member) | — | ✅ Implement and enforce role-based access |

## 6. Monitoring and Logging

| Control | GCP Responsibility | Foxtrot Responsibility |
|---------|-------------------|----------------------|
| Cloud Audit Logs | ✅ Log generation and storage | ✅ Enable, export, and review logs |
| Cloud Monitoring | ✅ Metrics collection infrastructure | ✅ Create alerts, uptime checks, dashboards |
| GKE Security Posture | ✅ Scanning infrastructure | ✅ Enable, review findings, remediate |
| Application-level audit logging | — | ✅ Workspace action logging with user attribution |
| Incident detection and response | — | ✅ Per Incident Response Plan |

## 7. Network Security

| Control | GCP Responsibility | Foxtrot Responsibility |
|---------|-------------------|----------------------|
| VPC firewalls | ✅ Firewall rule enforcement | ✅ Define firewall rules |
| DDoS protection | ✅ Cloud Armor (infrastructure-level) | ✅ Configure rate limiting if needed |
| TLS termination | — | ✅ nginx-ingress + Let's Encrypt cert-manager |
| DNS management | ✅ Cloud DNS infrastructure | ✅ Manage records, verify ownership |

## 8. GCP Compliance Certifications

GCP maintains the following certifications relevant to Roundtable's SOC 2 scope:

- SOC 1 / SOC 2 / SOC 3
- ISO 27001, 27017, 27018, 27701
- FedRAMP (Moderate)
- PCI DSS
- HIPAA (with BAA)

Auditors should reference GCP's compliance reports at: https://cloud.google.com/security/compliance/offerings

## 9. Complementary User Entity Controls (CUECs)

The following controls from GCP's SOC 2 report require action by Foxtrot Communications:

| CUEC | Status |
|------|--------|
| Customers should manage their own IAM policies | ✅ Implemented — least-privilege IAM bindings |
| Customers should enable logging for their resources | ✅ Implemented — Cloud Audit Logs enabled |
| Customers should manage encryption keys if using CMEK | ⚠️ Using default Google-managed keys (acceptable for initial audit) |
| Customers should restrict network access to their resources | ✅ Implemented — Cloud SQL authorized networks, VPC firewall rules |
| Customers should review access periodically | 📋 Planned — quarterly access reviews |

---

*Last reviewed: May 2026*
