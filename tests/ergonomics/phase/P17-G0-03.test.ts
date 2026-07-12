import { describe, expect, test } from 'bun:test';
import catalog from '../../../projects/p17/catalog.json';
import reconciliation from '../../../projects/p17/reviews/P17-G0-03-reconciliation.json';
import { validateArchitectureReconciliation } from '../../../scripts/p17-architecture-reconciliation';

type JsonObject = Record<string, unknown>;
const copy = (): JsonObject => structuredClone(reconciliation) as JsonObject;
const mutate = (fn: (value: JsonObject) => void, options = {}): string[] => {
  const value = copy();
  fn(value);
  return validateArchitectureReconciliation(value, options);
};
const rows = (value: JsonObject, key: string): JsonObject[] => value[key] as JsonObject[];

describe('P17-G0-03 architecture reconciliation boundary', () => {
  test('accepts the canonical structured authority and live evidence', () => {
    expect(validateArchitectureReconciliation(copy(), { catalog })).toEqual([]);
  });

  test('requires an exact closed schema and four non-conflated artifact roles', () => {
    expect(
      mutate((value) => {
        value.unreviewed = true;
      }),
    ).toContain(
      'reconciliation fields must equal: schemaVersion, kind, groupId, artifacts, dependencyOrder, factorReview, qualityScan, architectureDrift, cf001',
    );
    expect(mutate((value) => rows(value, 'artifacts').pop())).toContain(
      'artifacts must contain the exact artifact IDs: manifest, lock, plan, ledger',
    );
    expect(
      mutate((value) => {
        rows(value, 'artifacts')[0].file = 'config.toml';
      }),
    ).toContain('artifact manifest must use file skillsmith.toml');
  });

  test('rejects contradictory artifact facts and overlapping authority', () => {
    expect(
      mutate((value) => {
        rows(value, 'artifacts')[0].responsibility = 'machine-local-state';
      }),
    ).toContain(
      'artifact manifest responsibility must be portable-desired-state-and-project-defaults',
    );
    expect(
      mutate((value) => {
        rows(value, 'artifacts')[1].writerAuthority = 'lossless-manifest-writer';
      }),
    ).toContain('writer authority lossless-manifest-writer is assigned to multiple artifacts');
    expect(
      mutate((value) => {
        rows(value, 'artifacts')[0].forbids = ['desired-state'];
      }),
    ).toContain('artifact manifest owns and forbids desired-state');
  });

  test('requires exact Phase 2 -> 3A -> 3B -> 4A -> 4B order', () => {
    expect(
      mutate((value) => {
        const phases = rows(value, 'dependencyOrder');
        [phases[1], phases[2]] = [phases[2], phases[1]];
      }),
    ).toContain(
      'dependencyOrder must be exactly phase-2 -> phase-3a -> phase-3b -> phase-4a -> phase-4b',
    );
    expect(
      mutate((value) => {
        rows(value, 'dependencyOrder')[3].dependsOn = [];
      }),
    ).toContain('phase phase-4a must depend exactly on phase-3b');
  });

  test('locks all factor buckets to canonical actions and facts', () => {
    expect(mutate((value) => rows(value, 'factorReview').pop())).toContain(
      'factorReview must contain the exact buckets: good-precedent, following-bad-precedent, broken-precedent, new-pattern-introduced',
    );
    expect(
      mutate((value) => {
        rows(value, 'factorReview')[1].action = 'retain-command-transactions';
      }),
    ).toContain('factor bucket following-bad-precedent action contradicts the canonical authority');
    expect(
      mutate((value) => {
        rows(value, 'factorReview')[0].facts = ['opinion'];
      }),
    ).toContain('factor bucket good-precedent facts contradicts the canonical authority');
  });

  test('locks every quality axis to exact structured results', () => {
    expect(mutate((value) => rows(value, 'qualityScan').pop())).toContain(
      'qualityScan must contain the exact axes: contradictions, duplicate-semantics, unreachable-states, unclear-defaults, command-count-excess',
    );
    expect(
      mutate((value) => {
        rows(value, 'qualityScan')[0].result = 'contradictions-remain';
      }),
    ).toContain('quality finding P17-G0-03-Q01 result contradicts the canonical authority');
    expect(
      mutate((value) => {
        rows(value, 'qualityScan')[1].facts = ['config-is-manifest'];
      }),
    ).toContain('quality finding P17-G0-03-Q02 facts contradicts the canonical authority');
  });

  test('verifies evidence pointers against actual files and anchors', () => {
    expect(
      mutate((value) => {
        const evidence = rows(value, 'factorReview')[0].evidencePointers as JsonObject[];
        evidence[0].anchor = 'missing-anchor';
      }),
    ).toContain(
      'factor bucket good-precedent evidence anchor docs/superpowers/plans/2026-07-10-skillsmith-ergonomics-workflow-plan.md#missing-anchor does not exist',
    );
    expect(
      mutate((value) => {
        const evidence = rows(value, 'architectureDrift')[0].evidencePointers as JsonObject[];
        evidence[0].contains = 'already corrected wording';
      }),
    ).toContain(
      'architecture drift P17-G0-03-D01 evidence CLAUDE.md:7 does not contain already corrected wording',
    );
  });

  test('requires the exact two documentation drifts and CF-033..039 coverage', () => {
    expect(mutate((value) => rows(value, 'architectureDrift').pop())).toContain(
      'architectureDrift must contain exact IDs: P17-G0-03-D01, P17-G0-03-D02, EWP-CF-033, EWP-CF-034, EWP-CF-035, EWP-CF-036, EWP-CF-037, EWP-CF-038, EWP-CF-039',
    );
    expect(
      mutate((value) => {
        rows(value, 'architectureDrift')[0].downstreamOwner = 'P17-G1-01';
      }),
    ).toContain(
      'architecture drift P17-G0-03-D01 downstreamOwner contradicts the canonical authority',
    );
    expect(
      mutate((value) => {
        rows(value, 'architectureDrift')[4].target = 'mutable-monolith';
      }),
    ).toContain('architecture drift EWP-CF-035 target contradicts the canonical authority');
  });

  test('binds CF-001 coverage to the actual catalog group', () => {
    const changedCatalog = structuredClone(catalog) as JsonObject;
    const group = (changedCatalog.groups as JsonObject[]).find((entry) => entry.id === 'P17-G0-03');
    (group?.downstreamCoverage as string[]).pop();
    expect(validateArchitectureReconciliation(copy(), { catalog: changedCatalog })).toContain(
      'cf001.downstreamValidations must exactly equal G0-03 downstreamCoverage',
    );
    expect(
      mutate((value) => ((value.cf001 as JsonObject).downstreamValidations as string[]).pop(), {
        catalog,
      }),
    ).toContain('cf001.downstreamValidations must exactly equal G0-03 downstreamCoverage');
  });

  test('requires exact CF-001 contracts and finding identity', () => {
    expect(
      mutate((value) => {
        (value.cf001 as JsonObject).findingId = 'EWP-CF-999';
      }),
    ).toContain('cf001.findingId must be EWP-CF-001');
    expect(
      mutate((value) => ((value.cf001 as JsonObject).contractLinks as string[]).pop()),
    ).toContain('cf001.contractLinks must equal the canonical CF-001 contract set');
  });
});
