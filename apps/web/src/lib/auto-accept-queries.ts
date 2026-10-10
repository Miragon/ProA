import {
  applyAutoAcceptRule,
  getAutoAcceptRule,
  previewAutoAcceptRule,
  type ApplyAutoAcceptResult,
  type AutoAcceptCriteria,
  type AutoAcceptPreview,
  type AutoAcceptRuleDetail,
} from '@proa/client';
import { queryOptions } from '@tanstack/react-query';

import { api, unwrap } from './api';
import { keys } from './queries';

/** Queries of the tab „Regeln“ (owner decision 19); the keys are in `queries.ts`. */

/** One rule with its immutable revisions, oldest first. */
export const autoAcceptRuleQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: keys.autoAcceptRule(project, id),
    queryFn: (): Promise<AutoAcceptRuleDetail> =>
      unwrap(getAutoAcceptRule({ client: api, path: { project, rule: id } })),
  });

/**
 * What a rule (saved or a draft) would have accepted so far and would accept
 * now: a read-only POST, cached per criteria (the dialog debounces).
 */
export const autoAcceptPreviewQuery = (project: string, criteria: AutoAcceptCriteria) =>
  queryOptions({
    queryKey: keys.autoAcceptPreview(project, criteria),
    queryFn: (): Promise<AutoAcceptPreview> =>
      unwrap(previewAutoAcceptRule({ client: api, path: { project }, body: criteria })),
    staleTime: 10_000,
  });

/** The dry run of applying a rule's head revision to the open proposals (never cached). */
export const autoAcceptApplyDryRunQuery = (project: string, ruleId: string, revision: number) =>
  queryOptions({
    queryKey: keys.autoAcceptApplyDryRun(project, ruleId, revision),
    queryFn: (): Promise<ApplyAutoAcceptResult> =>
      unwrap(
        applyAutoAcceptRule({
          client: api,
          path: { project, rule: ruleId },
          query: { dryRun: 'true' },
          body: {},
        }),
      ),
    staleTime: 0,
    gcTime: 0,
  });
