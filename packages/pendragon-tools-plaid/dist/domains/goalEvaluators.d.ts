import type pg from 'pg';
import type { DomainType } from '../types.js';
type Pool = InstanceType<typeof pg.Pool>;
interface GoalProgress {
    goal_id: string;
    goal_name: string;
    goal_type: string;
    target_amount: number | null;
    target_date: string | null;
    current_value: number;
    progress_pct: number;
    on_track: boolean;
    projected_date: string | null;
    monthly_required: number | null;
    monthly_current: number | null;
    gap: number | null;
    recommendation: string;
    details: Record<string, unknown>;
    resource_request: {
        monthly_requested: number;
        urgency_score: number;
        urgency_factors: string[];
        deferrable: boolean;
        opportunity_cost: number;
    } | null;
    error?: string;
}
export declare function evaluateGoalProgress(pool: Pool, goalId: string, domainType: DomainType): Promise<GoalProgress>;
export {};
//# sourceMappingURL=goalEvaluators.d.ts.map