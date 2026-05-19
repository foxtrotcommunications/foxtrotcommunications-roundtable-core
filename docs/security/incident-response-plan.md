# Incident Response Plan

**Roundtable — Foxtrot Communications**
**Version:** 1.0
**Effective Date:** May 2026
**Owner:** Engineering Team
**Review Cadence:** Annually, or after any incident

---

## 1. Purpose

This plan establishes procedures for detecting, responding to, and recovering from security incidents affecting the Roundtable platform. It ensures a coordinated and consistent response that minimizes impact to customers, data, and operations.

## 2. Scope

This plan applies to all systems, infrastructure, and data within the Roundtable production environment, including:

- GKE cluster and all workspace pods
- Cloud SQL databases
- Firestore control plane data
- Artifact Registry container images
- Firebase Authentication
- Cloud DNS and networking infrastructure
- GitHub repositories

## 3. Incident Severity Levels

| Level | Name | Description | Response Time | Examples |
|-------|------|-------------|---------------|----------|
| **SEV-1** | Critical | Active data breach, complete service outage, or unauthorized access to production | Immediate (< 30 min) | Compromised credentials, data exfiltration, cluster-wide outage |
| **SEV-2** | High | Significant security issue or partial outage affecting multiple customers | < 2 hours | Single workspace compromised, Cloud SQL down, DNS failure |
| **SEV-3** | Medium | Security issue with limited blast radius, no data exposure | < 24 hours | Suspicious login patterns, failed deployment, single pod crash loop |
| **SEV-4** | Low | Minor security finding, no immediate risk | < 72 hours | Dependency vulnerability (no exploit), configuration drift |

## 4. Incident Response Phases

### 4.1 Detection

Incidents may be detected through:

- **Cloud Monitoring alerts** — Uptime checks, error rate spikes, resource exhaustion
- **Cloud Audit Logs** — Unauthorized API calls, IAM policy changes
- **GKE Security Posture** — Workload vulnerability findings
- **Artifact Registry scanning** — Container image CVEs
- **User reports** — Customer-reported issues or anomalies
- **Internal discovery** — Engineering team observations

### 4.2 Triage

Upon detection:

1. **Assign severity** using the table above
2. **Assign an Incident Commander (IC)** — the first engineer aware of the incident
3. **Create an incident record** — document the timeline, affected systems, and initial findings
4. **Notify stakeholders** per severity:
   - SEV-1/2: All engineering immediately + leadership within 1 hour
   - SEV-3/4: Engineering team within 24 hours

### 4.3 Containment

Immediate actions to limit blast radius:

| Scenario | Containment Action |
|----------|-------------------|
| Compromised workspace pod | `kubectl delete pod <name> -n <ns>` — pod is recreated clean |
| Compromised API key | Rotate key in Firebase/GCP console, revoke active sessions |
| Unauthorized cluster access | Revoke IAM binding, rotate service account keys |
| Suspicious user activity | Disable Firebase Auth account, audit workspace messages |
| Cloud SQL compromise | Rotate DB password, restrict authorized networks |
| DNS hijacking | Update Cloud DNS records, verify SSL certificate |

### 4.4 Eradication

After containment:

1. Identify the root cause (log analysis, timeline reconstruction)
2. Remove the threat vector (patch vulnerability, close access path)
3. Verify no lateral movement to other workspaces or systems
4. Scan all container images for related vulnerabilities

### 4.5 Recovery

1. Restore affected services from known-good state
2. Verify all workspace pods are running latest clean image
3. Confirm Cloud SQL data integrity via backup comparison
4. Re-enable any disabled accounts after verification
5. Monitor for recurrence (24-hour watch period)

### 4.6 Post-Incident Review

Within 72 hours of resolution:

1. Conduct blameless post-mortem
2. Document: timeline, root cause, impact, remediation steps
3. Identify action items to prevent recurrence
4. Update this IRP if gaps were identified
5. File post-mortem in `docs/security/post-mortems/`

## 5. Communication

| Audience | When | Channel |
|----------|------|---------|
| Engineering team | Immediately | Slack / phone |
| Leadership | SEV-1/2: within 1 hour | Email + phone |
| Affected customers | SEV-1: within 24 hours | Email |
| All customers | If data breach confirmed | Email + status page |

## 6. Roles and Responsibilities

| Role | Responsibility |
|------|---------------|
| **Incident Commander** | Coordinates response, makes containment decisions, owns communication |
| **Engineering Lead** | Technical investigation, eradication, and recovery |
| **Platform Owner** | Customer communication, business impact assessment |

## 7. Evidence Preservation

During any SEV-1 or SEV-2 incident:

- Export Cloud Audit Logs for the affected time period
- Capture pod logs before deletion (`kubectl logs`)
- Screenshot or export relevant GKE Security Posture findings
- Preserve Firestore audit records
- Do NOT modify or delete any evidence until post-mortem is complete

## 8. Annual Testing

This plan will be tested annually through:

- **Tabletop exercise**: Walk through a simulated SEV-1 scenario
- **Access review**: Verify all IAM bindings follow least privilege
- **Backup restore test**: Restore a Cloud SQL backup to verify integrity

---

*Last reviewed: May 2026*
