# Data Classification Policy

**Roundtable — Foxtrot Communications**
**Version:** 1.0
**Effective Date:** May 2026
**Owner:** Engineering Team
**Review Cadence:** Annually

---

## 1. Purpose

This policy defines data classification levels for the Roundtable platform, ensuring that all data is handled, stored, transmitted, and disposed of according to its sensitivity level.

## 2. Scope

This policy applies to all data created, processed, stored, or transmitted by the Roundtable platform, including:

- Customer workspace data (messages, files, AI conversations)
- Control plane data (organizations, members, billing)
- Authentication credentials and API keys
- Infrastructure configuration and secrets
- Logs and audit records

## 3. Classification Levels

### 3.1 Restricted

**Definition:** Data whose unauthorized disclosure would cause significant harm to customers or the business. Requires the highest level of protection.

| Data Type | Storage Location | Protection |
|-----------|-----------------|------------|
| User API keys (OpenAI, Anthropic, etc.) | Per-workspace Cloud SQL database | Encrypted at rest (AES-256 via Cloud SQL) |
| Database credentials | GCP Secret Manager | Encrypted at rest, IAM-scoped access |
| Firebase service account keys | K8s Secrets | Scoped to minimum required permissions |
| Session secrets | K8s Secrets | Unique per workspace |
| Cloud SQL passwords | K8s Secrets | Rotated on provisioning |

**Handling Requirements:**
- Must be encrypted at rest and in transit
- Access limited to service accounts with least-privilege IAM roles
- Never logged, displayed in UI, or included in error messages
- Rotated at minimum annually or upon suspected compromise

### 3.2 Confidential

**Definition:** Customer business data that is private to each tenant. Unauthorized cross-tenant access would constitute a breach.

| Data Type | Storage Location | Protection |
|-----------|-----------------|------------|
| Workspace messages and AI conversations | Per-workspace Cloud SQL database | Tenant-isolated (separate DB per workspace) |
| Uploaded files | Workspace pod filesystem | Isolated by K8s pod boundary |
| BigQuery/Snowflake/Databricks query results | Transient (in-memory during tool execution) | Not persisted beyond the AI response |
| Workspace configuration (model, system prompt) | Workspace Cloud SQL database | Per-tenant access only |

**Handling Requirements:**
- Stored in tenant-isolated databases (one per workspace)
- Accessible only by authenticated users assigned to the workspace
- Cross-workspace access requires explicit Workspace Bridge configuration
- Data warehouse query results are read-only and not persisted

### 3.3 Internal

**Definition:** Operational data that is not customer-specific but should not be publicly accessible.

| Data Type | Storage Location | Protection |
|-----------|-----------------|------------|
| Organization metadata | Firestore | Firebase Auth scoped |
| Member roles and assignments | Firestore | Role-based access (Owner/Admin/Member) |
| Usage metrics (token counts) | Per-workspace Cloud SQL | Aggregated, no PII |
| Audit log entries | Per-workspace Cloud SQL + Cloud Logging | Immutable after creation |
| Infrastructure configuration | Git repositories | Branch-protected |
| Container images | Artifact Registry | Vulnerability-scanned |

**Handling Requirements:**
- Standard access controls (authenticated users only)
- Logged access for audit purposes
- No special encryption beyond platform defaults

### 3.4 Public

**Definition:** Information intentionally made available to the public.

| Data Type | Location |
|-----------|----------|
| Landing page content | Dashboard frontend |
| Public documentation | GitHub README |
| Open-source source code (roundtable-core) | GitHub (public repo) |

**Handling Requirements:**
- Review before publication to ensure no Restricted or Confidential data is included
- No credentials, API keys, or internal URLs in public repositories

## 4. Data Lifecycle

### 4.1 Creation
- All new data inherits the classification of its container (e.g., messages in a workspace are Confidential)
- API keys entered by users are immediately classified as Restricted

### 4.2 Storage
- Restricted data: encrypted at rest, access-controlled
- Confidential data: tenant-isolated storage
- Internal data: standard platform storage with authentication
- Public data: no restrictions

### 4.3 Transmission
- All data in transit is encrypted via TLS 1.2+ (enforced by nginx-ingress + Let's Encrypt)
- WebSocket connections (Socket.IO) operate over WSS (encrypted)
- Intra-cluster communication between pods uses cluster-internal networking

### 4.4 Retention
- **Demo workspaces:** Daily wipe via CronJob (messages, files, usage data cleared)
- **Production workspaces:** Retained for the lifetime of the workspace
- **Audit logs:** Retained for minimum 1 year
- **Cloud SQL backups:** Automated, retained per GCP default policy (7 days)

### 4.5 Disposal
- Workspace deletion triggers: pod termination, database drop, DNS record removal, Ingress deletion
- Cloud SQL automated backups expire per retention policy
- No manual data recovery is possible after workspace deletion

## 5. Responsibilities

| Role | Responsibility |
|------|---------------|
| **Engineering Team** | Implement and maintain technical controls for each classification level |
| **Workspace Admins** | Ensure users understand data handling expectations for their workspace |
| **All Users** | Do not share Restricted data outside authorized channels |

---

*Last reviewed: May 2026*
