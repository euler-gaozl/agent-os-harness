import {tokenUsageProjectionDefinition,contextPressureProjectionDefinition}
  from '../upstream/packages/llm/token-meter/src/usage-projection.ts';
import {contextBreakdownProjectionDefinition}
  from '../upstream/packages/llm/token-meter/src/breakdown-projection.ts';
import {turnBoundaryProjectionDefinition} from '../upstream/packages/core/agent-loop/src/index.ts';
import {inboxProjectionDefinition} from '../upstream/packages/core/agent-loop/src/inbox.ts';

// Compare original definition objects, not user-provided names/versions. Called
// after module initialization, avoiding eager reads across the registry cycle.
export function isResidentProjection(definition: object): boolean {
  return definition===tokenUsageProjectionDefinition || definition===contextPressureProjectionDefinition
    || definition===contextBreakdownProjectionDefinition || definition===turnBoundaryProjectionDefinition
    || definition===inboxProjectionDefinition;
}
