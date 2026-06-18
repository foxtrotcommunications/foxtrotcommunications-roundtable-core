import type { ProvenancePayload } from '../../types/provenance';
import ProvenanceSection from './ProvenanceSection';
import '../../styles/provenance.css';

interface Props {
  provenance: ProvenancePayload;
}

export default function ProvenanceFooter({ provenance }: Props) {
  const { system: sys, reasoning } = provenance;

  // Confidence color
  const confColor = sys.confidence >= 85 ? 'var(--prov-green)'
    : sys.confidence >= 65 ? 'var(--prov-amber)'
    : 'var(--prov-red)';

  return (
    <div className="provenance-footer">
      {/* Always-visible summary line */}
      <div className="prov-summary">
        <span className="prov-confidence-badge" style={{ color: confColor }}>
          🎯 {sys.confidenceLabel} ({sys.confidence}%)
        </span>
        <span className="prov-summary-meta">
          {sys.domainsConsulted.length > 0 && `· ${sys.domainsConsulted.length} domain${sys.domainsConsulted.length > 1 ? 's' : ''}`}
          {sys.dataAge && ` · ${sys.dataAge}`}
        </span>
      </div>

      {/* 1. Confidence */}
      <ProvenanceSection icon="🎯" label="Confidence" summary={`${sys.confidenceLabel} (${sys.confidence}%)`}>
        <div className="prov-detail">
          <div className="prov-confidence-bar">
            <div className="prov-confidence-fill" style={{ width: `${sys.confidence}%`, backgroundColor: confColor }} />
          </div>
          <p>Coverage: {sys.domainsConsulted.length} of {sys.domainsAvailable} connected domains</p>
          <p>Freshness: {sys.dataAge || 'N/A'}</p>
          {sys.domainsConsulted.length > 0 && (
            <p>Domains: {sys.domainsConsulted.join(', ')}</p>
          )}
        </div>
      </ProvenanceSection>

      {/* 2. Data Sources */}
      <ProvenanceSection
        icon="📊"
        label="Data Sources"
        summary={`${sys.accountsAnalyzed > 0 ? `${sys.accountsAnalyzed} accounts` : ''}${sys.transactionsReviewed > 0 ? ` · ${sys.transactionsReviewed} transactions` : ''}`}
      >
        <div className="prov-detail">
          {sys.domainsConsulted.map(d => (
            <div key={d} className="prov-source-item">✓ {d}</div>
          ))}
          {sys.bridgeCalls.length > 0 && (
            <div className="prov-bridge-list">
              {sys.bridgeCalls.map((b, i) => (
                <div key={i} className="prov-bridge-item">
                  → {b.targetWorkspace} · {b.capability} · {b.durationMs}ms
                </div>
              ))}
            </div>
          )}
          {sys.accountsAnalyzed > 0 && <p>{sys.accountsAnalyzed} accounts analyzed</p>}
          {sys.transactionsReviewed > 0 && <p>{sys.transactionsReviewed} transactions reviewed</p>}
        </div>
      </ProvenanceSection>

      {/* 3. Reasoning */}
      {reasoning && (reasoning.assumptions.length > 0 || reasoning.keyCalculations.length > 0 || reasoning.keyDrivers.length > 0) && (
        <ProvenanceSection
          icon="🧮"
          label="Reasoning"
          summary={`${reasoning.assumptions.length} assumption${reasoning.assumptions.length !== 1 ? 's' : ''} · ${reasoning.keyCalculations.length} calculation${reasoning.keyCalculations.length !== 1 ? 's' : ''}`}
        >
          <div className="prov-detail">
            {reasoning.keyDrivers.length > 0 && (
              <div className="prov-sub-section">
                <div className="prov-sub-label">⭐ Key Drivers</div>
                <ul>{reasoning.keyDrivers.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </div>
            )}
            {reasoning.assumptions.length > 0 && (
              <div className="prov-sub-section">
                <div className="prov-sub-label">Assumptions</div>
                <ul>{reasoning.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </div>
            )}
            {reasoning.keyCalculations.length > 0 && (
              <div className="prov-sub-section">
                <div className="prov-sub-label">Calculations</div>
                <ul>{reasoning.keyCalculations.map((c, i) => <li key={i}>{c}</li>)}</ul>
              </div>
            )}
          </div>
        </ProvenanceSection>
      )}

      {/* 4. Missing Data */}
      {reasoning && (reasoning.missingDomains.length > 0 || reasoning.limitations.length > 0 || reasoning.wouldImprove.length > 0) && (
        <ProvenanceSection
          icon="❓"
          label="Missing Data"
          summary={reasoning.missingDomains.length > 0 ? `${reasoning.missingDomains.length} domain${reasoning.missingDomains.length !== 1 ? 's' : ''} not connected` : undefined}
        >
          <div className="prov-detail">
            {reasoning.missingDomains.length > 0 && (
              <div className="prov-sub-section">
                <div className="prov-sub-label">Not Connected</div>
                <ul>{reasoning.missingDomains.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </div>
            )}
            {reasoning.wouldImprove.length > 0 && (
              <div className="prov-sub-section">
                <div className="prov-sub-label">Would Improve This Answer</div>
                <ul>{reasoning.wouldImprove.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            {reasoning.limitations.length > 0 && (
              <div className="prov-sub-section">
                <div className="prov-sub-label">Limitations</div>
                <ul>{reasoning.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
              </div>
            )}
          </div>
        </ProvenanceSection>
      )}

      {/* 5. Technical Details */}
      {sys.toolsCalled.length > 0 && (
        <ProvenanceSection icon="🔧" label="Technical Details" summary={`${sys.toolsCalled.length} tool call${sys.toolsCalled.length !== 1 ? 's' : ''} · ${sys.totalDurationMs}ms`}>
          <div className="prov-detail">
            {sys.toolsCalled.map((t, i) => (
              <div key={i} className="prov-tool-item">
                <span className={`prov-tool-status ${t.status}`}>{t.status === 'success' ? '✓' : '✗'}</span>
                <span className="prov-tool-name">{t.name}</span>
                <span className="prov-tool-duration">{t.durationMs}ms</span>
              </div>
            ))}
            <div className="prov-tool-total">Total: {sys.toolsCalled.length} calls · {sys.totalDurationMs}ms</div>
          </div>
        </ProvenanceSection>
      )}
    </div>
  );
}
