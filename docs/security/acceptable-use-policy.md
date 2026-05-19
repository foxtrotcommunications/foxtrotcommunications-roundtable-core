# Acceptable Use Policy

**Roundtable — Foxtrot Communications**
**Version:** 1.0
**Effective Date:** May 2026
**Owner:** Engineering Team
**Review Cadence:** Annually

---

## 1. Purpose

This policy defines acceptable and prohibited uses of the Roundtable platform and its supporting infrastructure. It protects customers, the platform, and Foxtrot Communications from security risks, abuse, and legal liability.

## 2. Scope

This policy applies to all users of the Roundtable platform, including:

- Foxtrot Communications employees and contractors
- Organization owners, admins, and members
- AI agents operating within workspaces
- Any automated systems interacting with the platform

## 3. Acceptable Use

### 3.1 Platform Usage

Users may:

- Create and participate in AI-assisted conversations within assigned workspaces
- Configure AI providers, models, and system prompts for their workspaces
- Use built-in tools (web search, data warehouse queries, file management, code execution) for legitimate business purposes
- Upload files and clone repositories relevant to their work
- Connect personal API keys for supported AI providers

### 3.2 Data Warehouse Access

Users may:

- Execute read-only queries against configured BigQuery, Snowflake, and Databricks instances
- Analyze query results within the workspace context
- Export query results via workspace file tools

### 3.3 Code Execution

Users may:

- Execute JavaScript in the sandboxed `run_code` environment
- Run allowlisted shell commands via `shell_exec`
- Clone public or authorized private repositories

## 4. Prohibited Use

### 4.1 Security Violations

Users must NOT:

- Attempt to access workspaces, databases, or infrastructure to which they are not authorized
- Share authentication credentials, session tokens, or API keys with unauthorized parties
- Attempt to bypass workspace isolation boundaries
- Probe, scan, or test the vulnerability of the platform without explicit authorization
- Circumvent the shell command allowlist or file system restrictions
- Attempt to escalate privileges beyond their assigned role (Member → Admin → Owner)

### 4.2 Data Handling Violations

Users must NOT:

- Store, transmit, or process data in violation of applicable laws or regulations
- Access or exfiltrate data from other tenants' workspaces
- Use data warehouse query tools to access data they are not authorized to view
- Disable or tamper with audit logging
- Attempt to recover data from deleted workspaces

### 4.3 AI and Content Violations

Users must NOT:

- Use the AI to generate content that violates applicable laws
- Attempt to extract, reverse-engineer, or exfiltrate AI model weights or proprietary model behavior
- Use the platform to conduct attacks against third-party systems (e.g., using `web_search` or `read_url` for reconnaissance)
- Exceed daily token limits through automated or scripted means designed to bypass spend caps

### 4.4 Infrastructure Violations

Users must NOT:

- Deploy unauthorized workloads on the GKE cluster
- Modify Kubernetes resources outside of the dashboard's managed lifecycle
- Consume excessive compute, memory, or storage resources in a manner that degrades service for other tenants
- Use workspace pods for cryptocurrency mining, denial-of-service attacks, or other non-platform activities

## 5. Monitoring and Enforcement

### 5.1 Monitoring

The platform monitors:

- All workspace messages and AI interactions (persisted in workspace database)
- Tool invocations and results (logged with user attribution)
- Workspace lifecycle actions (audit log)
- Token consumption per user, per model (usage tracking)
- Kubernetes pod resource consumption

### 5.2 Enforcement

Violations may result in:

| Severity | Action |
|----------|--------|
| Minor (first offense) | Warning to user and workspace admin |
| Moderate | Temporary suspension of workspace access |
| Severe | Immediate account termination and workspace deletion |
| Criminal activity | Account termination, evidence preservation, and law enforcement referral |

### 5.3 Reporting

Users who become aware of a policy violation should report it to their workspace admin or contact Foxtrot Communications directly. Reports will be handled confidentially.

## 6. Acknowledgement

By accessing the Roundtable platform, users agree to comply with this Acceptable Use Policy. Organization owners are responsible for ensuring their members are aware of and adhere to these terms.

---

*Last reviewed: May 2026*
