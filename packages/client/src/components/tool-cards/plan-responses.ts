import type { PlanComment } from './plan-annotations';

export const PLAN_ACCEPTED_RESPONSE = 'Plan accepted';
export const PLAN_REJECTED_RESPONSE = 'Plan rejected. Do not proceed with this plan.';

export function formatPlanAcceptedResponse(plan: string, originalPlan?: string) {
  const trimmedPlan = plan.trim();
  const trimmedOriginal = originalPlan?.trim() ?? trimmedPlan;
  if (!trimmedPlan || trimmedPlan === trimmedOriginal) return PLAN_ACCEPTED_RESPONSE;
  return `Plan accepted with revisions:\n\n${trimmedPlan}`;
}

export function formatPlanCommentsFeedback(planComments: PlanComment[]) {
  const parts = planComments.map((comment) => {
    const quote =
      comment.selectedText.length > 100
        ? comment.selectedText.slice(0, 100) + '...'
        : comment.selectedText;
    if (comment.emoji && comment.comment) return `> ${quote}\n${comment.emoji} ${comment.comment}`;
    if (comment.emoji) return `> ${quote}\n${comment.emoji}`;
    return `> ${quote}\nComment: ${comment.comment}`;
  });
  return `Feedback on plan:\n\n${parts.join('\n\n')}`;
}
