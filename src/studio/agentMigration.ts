/**
 * Moves an Agent task (docs/agent-harness.md) into a Studio Chat conversation (docs/agent-studio.md,
 * "Agent tasks moved to Studio"). The goal and criteria carry over; the steps not done yet become
 * code steps of the conversation's plan, on the task's branch; the steps done are said in the chat.
 * A task with a step waiting for review is not moved: its changes are on disk and only the Agent
 * can accept or undo them. Nothing is deleted. No `vscode` here.
 */
import { planProblems } from './chatPlanner';
import { ChatStore, Conversation, newMessage } from './chatStore';
import { StepDefinition } from './steps';
import { Workflow, WORKFLOW_FORMAT } from './workflow';
import { AgentTask, PlanStep, StepVerification } from '../agent/types';

const VERIFIED: Record<StepVerification, string> = {
  passed: 'checks passed', failed: 'accepted with failing checks', unverified: 'accepted as unverified',
  docsOnly: 'documentation only', noChanges: 'no file changed'
};

const slug = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40) || 'task';

/** Why a task cannot be moved now; undefined when it can. */
export function moveBlocker(task: AgentTask): string | undefined {
  if (task.status === 'stepReview') { return `Step ${task.current + 1} is waiting for your review: Accept, Retry or Stop it in the task first.`; }
  if (task.status === 'planning' || task.status === 'stepRunning') { return 'It is running: wait for it, or cancel it, first.'; }
  return undefined;
}

/** The plan of the steps not done yet, as code steps on the task's branch, one after another. */
export function remainingPlan(task: AgentTask): Workflow | undefined {
  const remaining = (task.plan ?? []).map((step, index) => ({ step, index })).filter(({ step }) => step.state === 'pending');
  if (!remaining.length || task.status === 'done' || task.status === 'stopped') { return undefined; }
  const nodes = remaining.map(({ step, index }) => ({
    id: `step-${index + 1}`, type: 'code', title: step.title,
    with: {
      task: step.intent || step.title,
      paths: step.paths,
      ...(step.checks.length ? { checks: step.checks } : {}),
      ...(task.branch ? { branch: task.branch } : {})
    }
  }));
  return {
    schema: WORKFLOW_FORMAT, id: slug(task.title), version: '0.1.0', title: task.title, description: task.goal,
    ...(task.criteria.length ? { criteria: task.criteria } : {}),
    nodes,
    edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }))
  };
}

function doneLine(step: PlanStep, index: number): string {
  const how = step.state === 'skipped' ? 'skipped' : step.verification ? VERIFIED[step.verification] : 'done';
  const failing = step.acceptedDespite?.length ? ` (failing: ${step.acceptedDespite.join(', ')})` : '';
  return `${index + 1}. ${step.title}: ${how}${failing}`;
}

/** The conversation a task becomes, ready to save; or why it cannot be moved now. */
export function taskToConversation(task: AgentTask, chats: ChatStore, steps: Map<string, StepDefinition>): { conversation: Conversation } | { blocked: string } {
  const blocker = moveBlocker(task);
  if (blocker) { return { blocked: blocker }; }
  const conversation = chats.create();
  conversation.title = task.title;
  conversation.createdAt = task.createdAt;
  conversation.messages.push(newMessage({
    role: 'user',
    text: [task.goal, task.criteria.length ? `\nDone when:\n${task.criteria.map(item => `- ${item}`).join('\n')}` : ''].join('')
  }));
  const done = (task.plan ?? []).map((step, index) => ({ step, index })).filter(({ step }) => step.state !== 'pending');
  const plan = remainingPlan(task);
  const status = task.status === 'done' ? 'It was finished.' : task.status === 'stopped' ? 'It was stopped.' : !task.plan?.length ? 'It had no plan yet: send a message to draft one.' : task.status === 'planReview' ? 'Its plan was not approved yet.' : '';
  const retried = plan ? (task.plan ?? []).filter(step => step.state === 'pending' && step.feedback).map(step => `"${step.title}" was retried before: ${step.feedback!.slice(0, 600)}`) : [];
  conversation.messages.push(newMessage({
    role: 'assistant',
    text: [
      `Moved from the Agent task "${task.title}" (${task.id}, ${task.createdAt.slice(0, 10)}). ${status}`.trim(),
      task.branch ? `Its branch: ${task.branch}.${plan ? ' The steps below work on it: switch to it before Run.' : ''}` : '',
      done.length ? `Done in the Agent:\n${done.map(({ step, index }) => doneLine(step, index)).join('\n')}` : '',
      plan ? `The steps not done yet are the plan below, as code steps you review.` : '',
      ...retried
    ].filter(Boolean).join('\n\n'),
    ...(plan ? { draft: { workflow: plan, problems: planProblems(plan, steps), status: 'current' as const } } : {})
  }));
  if (plan) { conversation.plan = plan; }
  return { conversation };
}
