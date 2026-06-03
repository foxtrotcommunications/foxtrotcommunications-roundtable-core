// @ts-nocheck
import fetch from 'node-fetch';

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'trigger_synthea_pipeline',
  description: 'Trigger a Bellows Synthea pipeline run to generate synthetic FHIR patient data from a custom Synthea module committed to a Git repository. The pipeline runs Synthea with the custom module, ingests FHIR Bundles into BigQuery staging, and optionally triggers Forge normalization to OMOP CDM. Returns immediately with a run_id — use query_bigquery on synthea_cohort_registry to check status.',
  parameters: {
    type: 'object',
    properties: {
      module_repo: {
        type: 'string',
        description: 'GitHub repo containing the Synthea module (e.g., "foxtrotcommunications/foxtrotcommunications-avalon")',
      },
      module_path: {
        type: 'string',
        description: 'Path to the module JSON file within the repo (e.g., "synthea/modules/eccdm_solid_tumor.json")',
      },
      module_commit_sha: {
        type: 'string',
        description: 'Git commit SHA of the module to use. Ensures reproducibility. If omitted, uses HEAD of default branch.',
      },
      patient_count: {
        type: 'number',
        description: 'Number of synthetic patients to generate (default: 1000, max: 50000)',
      },
      state: {
        type: 'string',
        description: 'US state for demographic distribution (default: "Massachusetts")',
      },
      seed: {
        type: 'number',
        description: 'Optional random seed for reproducible generation',
      },
      cohort_label: {
        type: 'string',
        description: 'Human-readable label for this cohort (e.g., "ECCDM Solid Tumor v1")',
      },
      trigger_forge: {
        type: 'boolean',
        description: 'Whether to trigger Forge FHIR to OMOP normalization after ingestion (default: true)',
      },
      ig_source: {
        type: 'string',
        description: 'Source FHIR Implementation Guide (e.g., "HL7 EU Cancer Common v0.1.0")',
      },
    },
    required: ['module_repo', 'module_path'],
  },
  async execute(args: any, workspaceConfig: any = {}, _context?: any) {
    const BELLOWS_URL = process.env.BELLOWS_SERVICE_URL || 'https://foxtrotcommunications-bellows-<hash>.run.app';
    const BELLOWS_TOKEN = process.env.ROUNDTABLE_SERVICE_TOKEN;
    
    const patientCount = Math.min(args.patient_count || 1000, 50000);
    
    const body = {
      module_repo: args.module_repo,
      module_path: args.module_path,
      module_commit_sha: args.module_commit_sha || null,
      patient_count: patientCount,
      state: args.state || 'Massachusetts',
      seed: args.seed || null,
      cohort_label: args.cohort_label || null,
      trigger_forge: args.trigger_forge !== false,
      ig_source: args.ig_source || null,
    };
    
    try {
      // Get OIDC token for service-to-service auth if no static token
      let authHeader;
      if (BELLOWS_TOKEN) {
        authHeader = `Bearer ${BELLOWS_TOKEN}`;
      } else {
        // Attempt GCP metadata server for OIDC token
        try {
          const tokenRes = await fetch(
            `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${BELLOWS_URL}`,
            { headers: { 'Metadata-Flavor': 'Google' } }
          );
          if (tokenRes.ok) {
            authHeader = `Bearer ${await tokenRes.text()}`;
          }
        } catch {
          // Not on GCP — proceed without auth for local dev
        }
      }
      
      const headers = { 'Content-Type': 'application/json' };
      if (authHeader) headers['Authorization'] = authHeader;
      
      const res = await fetch(`${BELLOWS_URL}/synthea/run-custom`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeout: 30000,
      });
      
      if (!res.ok) {
        const errText = await res.text();
        return { error: `Bellows API returned ${res.status}: ${errText}` };
      }
      
      const result = await res.json();
      
      return {
        status: result.status || 'accepted',
        run_id: result.run_id,
        cohort_id: result.cohort_id || result.run_id,
        patient_count: patientCount,
        estimated_duration_minutes: result.estimated_duration_minutes || Math.ceil(patientCount / 1000) * 1.5,
        module: `${args.module_repo}/${args.module_path}`,
        message: `Synthea pipeline triggered. Use query_bigquery to check status: SELECT * FROM bellows_fhir_staging.synthea_cohort_registry WHERE cohort_id = '${result.run_id}'`,
      };
    } catch (err: any) {
      return { error: `Failed to trigger Bellows pipeline: ${err.message}` };
    }
  },
};

export default tool;
