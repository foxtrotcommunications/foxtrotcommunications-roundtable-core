# How the OMOP Synthetic Healthcare Data Was Created

This document explains the end-to-end pipeline that generates the synthetic healthcare data available in this workspace. The data follows the **OMOP Common Data Model (CDM) v5.4** and contains ~1,000 synthetic patients with full clinical histories.

## Pipeline Overview

```
Synthea (Patient Generator)
    ↓ FHIR R4 JSON Bundles
GCS Staging (Cloud Storage)
    ↓ Parse & extract
BigQuery Staging (raw FHIR tables)
    ↓ Forge Engine (JSON unnesting)
Normalized Flat Tables (per resource type)
    ↓ Materialization
forge_synthetic_fhir dataset (public)
    ↓ OMOP view creation + vocabulary JOINs
OMOP CDM 5.4 Views (omop_* tables)
```

## Step 1: Synthetic Patient Generation (Synthea)

**Tool:** [Synthea](https://github.com/synthetichealth/synthea) — an open-source synthetic patient generator maintained by MITRE.

Synthea creates realistic (but entirely fictional) patient records by simulating disease progression, treatments, and outcomes over a patient's lifetime. Each patient gets a complete medical history including:

- Demographics (age, gender, race, ethnicity, address)
- Conditions (diagnosed diseases and their progression)
- Medications (prescriptions with start/stop dates and dosages)
- Procedures (surgeries, lab work, imaging)
- Observations (vitals, lab results, scores)
- Encounters (office visits, ED visits, hospitalizations)
- Immunizations (childhood and adult vaccines)
- Claims and costs (payer, coverage, claim amounts)

**Output format:** FHIR R4 JSON Bundles — one file per patient containing all of their clinical resources.

**Configuration used:**
- ~1,000 patients
- Massachusetts (default state)
- US Core Implementation Guide enabled
- FHIR R4 export format
- Custom disease modules can be added for specific conditions (e.g., solid tumor oncology)

## Step 2: Ingestion into BigQuery

The FHIR Bundle JSON files are uploaded to Google Cloud Storage, then parsed and loaded into BigQuery staging tables.

**Process:**
1. Read each FHIR Bundle JSON file from GCS
2. Split resources by type (Patient, Encounter, Condition, Observation, etc.)
3. Extract key scalar fields (resource_id, patient_id, encounter_id, dates, codes, values)
4. Store the full FHIR resource as a `raw_json` column for complete data preservation
5. Load into staging dataset with tables named `raw_{resourcetype}`

**Staging tables:** `raw_patient`, `raw_encounter`, `raw_condition`, `raw_observation`, `raw_procedure`, `raw_immunization`, `raw_medicationrequest`, `raw_diagnosticreport`, `raw_claim`, `raw_explanationofbenefit`, `raw_coverage`

Tables are partitioned by `_ingested_date` and clustered by `synthea_run_id` for efficient querying.

## Step 3: Forge Normalization (JSON → Flat Tables)

The **Forge** engine takes the nested FHIR JSON and transforms it into flat, queryable relational tables.

**How it works:**
1. For each resource type, Forge performs a **breadth-first traversal** of the JSON structure
2. It discovers all nested fields, arrays, and sub-objects automatically
3. It generates dbt models at each nesting level (root, level 1, level 2, etc.)
4. It materializes flat tables and creates a `frg__rollup` view that LEFT JOINs all levels together
5. Field descriptions are automatically applied from the FHIR R4 specification

**Output:** One dataset per resource type (e.g., `fhir_normalized_patient`, `fhir_normalized_encounter`) with full rollup views.

## Step 4: Public Dataset Materialization

The rollup views are materialized into permanent tables in the `forge_synthetic_fhir` dataset:

| Table | Source | Description |
|-------|--------|-------------|
| `patient` | FHIR Patient | Demographics, birth/death dates, contact info |
| `encounter` | FHIR Encounter | Visits, hospitalizations, ED visits |
| `condition` | FHIR Condition | Diagnosed conditions with SNOMED codes |
| `observation` | FHIR Observation | Lab results, vitals, assessments |
| `procedure` | FHIR Procedure | Surgical and diagnostic procedures |
| `immunization` | FHIR Immunization | Vaccine administrations |
| `medication_request` | FHIR MedicationRequest | Prescriptions and medication orders |
| `diagnostic_report` | FHIR DiagnosticReport | Lab panels and imaging reports |

## Step 5: OMOP CDM v5.4 Views

The final layer transforms the flat FHIR tables into the **OMOP Common Data Model** format by joining with OHDSI standard vocabularies.

### What is OMOP?

The **Observational Medical Outcomes Partnership (OMOP)** Common Data Model is an open community standard for healthcare data. Instead of storing clinical concepts as text strings, OMOP uses integer `concept_id` values from standardized vocabularies (SNOMED, LOINC, RxNorm, etc.). This enables:

- Cross-organization analytics (same query works everywhere)
- Standardized cohort definitions
- Reproducible research
- Efficient joins via integer IDs

### OMOP Views in This Workspace

| OMOP Table | Source FHIR Resource | Key Vocabulary |
|-----------|---------------------|----------------|
| `omop_person` | Patient | Race, Ethnicity concept IDs |
| `omop_observation_period` | Encounter (aggregated) | — |
| `omop_provider` | Encounter.participant | — |
| `omop_visit_occurrence` | Encounter | Visit type concepts |
| `omop_condition_occurrence` | Condition | SNOMED codes |
| `omop_procedure_occurrence` | Procedure | SNOMED codes |
| `omop_drug_exposure` | MedicationRequest | RxNorm codes |
| `omop_measurement` | Observation (numeric values) | LOINC, UCUM |
| `omop_observation` | Observation (non-numeric) | LOINC |
| `omop_death` | Patient (deceased flag) | SNOMED |
| `omop_cost` | Claim + Explanation of Benefit | — |

### How Concept Resolution Works

When you see a `condition_concept_id` like `201826`, you can resolve it:

```sql
SELECT concept_name, vocabulary_id, domain_id
FROM `foxtrot-communications-public.omop_vocabulary.concept`
WHERE concept_id = 201826
-- Returns: "Type 2 diabetes mellitus", "SNOMED", "Condition"
```

The vocabulary JOIN happens automatically in the OMOP views, so you can query by concept name or ID.

## Step 6: Vocabulary Tables

The OMOP vocabulary tables were loaded from [OHDSI Athena](https://athena.ohdsi.org/), the official vocabulary distribution service.

**Dataset:** `omop_vocabulary` in `foxtrot-communications-public`

| Table | Description | Approximate Size |
|-------|-------------|-----------------|
| `concept` | Master concept lookup (SNOMED, LOINC, RxNorm, UCUM, etc.) | ~1.5M rows |
| `concept_relationship` | Maps between concepts ("Maps to" relationships) | ~3M rows |
| `concept_ancestor` | Transitive closure hierarchy for descendant queries | Large |
| `vocabulary` | Vocabulary metadata | Small |
| `domain` | Domain definitions (Condition, Drug, Measurement, etc.) | Small |
| `concept_class` | Concept class metadata | Small |
| `relationship` | Relationship type definitions | Small |
| `drug_strength` | Drug ingredient strength information | Medium |

**Included vocabularies:** SNOMED, LOINC, RxNorm, RxNorm Extension, UCUM, Gender, Race, Ethnicity, Visit, Type Concept, plus domain-specific type vocabularies.

## Example Queries

**Count patients by gender:**
```sql
SELECT p.gender, COUNT(*) as patient_count
FROM `foxtrot-communications-public.forge_synthetic_fhir.patient` p
GROUP BY p.gender
```

**Top 10 conditions with OMOP concept names:**
```sql
SELECT c.concept_name, COUNT(*) as occurrences
FROM `foxtrot-communications-public.forge_synthetic_fhir.omop_condition_occurrence` co
JOIN `foxtrot-communications-public.omop_vocabulary.concept` c
  ON co.condition_concept_id = c.concept_id
GROUP BY c.concept_name
ORDER BY occurrences DESC
LIMIT 10
```

**Average lab values by test type:**
```sql
SELECT c.concept_name, AVG(m.value_as_number) as avg_value, m.unit_source_value
FROM `foxtrot-communications-public.forge_synthetic_fhir.omop_measurement` m
JOIN `foxtrot-communications-public.omop_vocabulary.concept` c
  ON m.measurement_concept_id = c.concept_id
WHERE m.value_as_number IS NOT NULL
GROUP BY c.concept_name, m.unit_source_value
ORDER BY COUNT(*) DESC
LIMIT 20
```

## Important Notes

- **All data is synthetic.** No real patient information was used at any stage. Synthea generates fictional patients with statistically realistic distributions.
- **The pipeline is automated.** New cohorts can be generated on demand with custom disease modules and patient counts.
- **OMOP CDM v5.4** is the latest version of the standard, maintained by the OHDSI community.
