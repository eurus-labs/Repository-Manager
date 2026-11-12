/**
 * Moves an Agent task (docs/agent-harness.md) into a Studio Chat conversation (docs/agent-studio.md,
 * "Agent tasks moved to Studio"). The goal and criteria carry over; the steps not done yet become
 * code steps of the conversation's plan, on the task's branch; the steps done are said in the chat.
 * A step that ran and waited for review keeps its changes on disk: the chat names the files, and
 * the person keeps or undoes them with Git. Nothing is deleted. No `vscode` here.
 */
import { planProblems } from './chatPlanner';
import { ChatStore, Conversation, newMessage } from './chatStore';
import { StepDefinition } from './steps';
import { Workflow, WORKFLOW_FORMAT } from './workflow';
import { AgentTask, PlanStep, StepVerification } from '../agent/types';
import { revertChanges } from '../agent/agentTools';
import { TaskStore } from '../agent/taskStore';
import { studioSteps } from './registry';
import * as path from 'path';

const VERIFIED: Record<StepVerification, string> = {
  passed: 'checks passed', failed: 'accepted with failing checks', unverified: 'accepted as unverified',
  docsOnly: 'documentation only', noChanges: 'no file changed'
};

const slug = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40) || 'task';

/** A step that ran and was waiting for review when the task moved: its changes are still in the files. */
export function stepUnderReview(task: AgentTask): PlanStep | undefined {
  return task.status === 'stepReview' ? task.plan?.[task.current] : undefined;
}

/** The plan of the steps not done yet, as code steps on the task's branch, one after another. */
export function remainingPlan(task: AgentTask): Workflow | undefined {
  const reviewed = stepUnderReview(task);
  const remaining = (task.plan ?? []).map((step, index) => ({ step, index })).filter(({ step }) => step.state === 'pending' && step !== reviewed);
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
export function taskToConversation(task: AgentTask, chats: ChatStore, steps: Map<string, StepDefinition>): Conversation {
  const conversation = chats.create();
  conversation.title = task.title;
  // The task's steps name paths of its repository: the plan runs only with that repository open.
  conversation.repositoryRoot = task.repositoryRoot;
  conversation.createdAt = task.createdAt;
  conversation.messages.push(newMessage({
    role: 'user',
    text: [task.goal, task.criteria.length ? `\nDone when:\n${task.criteria.map(item => `- ${item}`).join('\n')}` : ''].join('')
  }));
  const done = (task.plan ?? []).map((step, index) => ({ step, index })).filter(({ step }) => step.state !== 'pending');
  const plan = remainingPlan(task);
  const status = task.status === 'done' ? 'It was finished.' : task.status === 'stopped' ? 'It was stopped.' : !task.plan?.length ? 'It had no plan yet: send a message to draft one.' : task.status === 'planReview' ? 'Its plan was not approved yet.' : '';
  const reviewed = stepUnderReview(task);
  const reviewNote = reviewed ? `Step ${task.current + 1} "${reviewed.title}" ran and was waiting for your review. Its changes are still in these files, not committed: ${(reviewed.result?.changes ?? []).map(change => change.path).join(', ') || 'none'}. Keep them, or undo them with Git; if you undo them, ask here to add that step to the plan again.` : '';
  const retried = plan ? (task.plan ?? []).filter(step => step.state === 'pending' && step.feedback).map(step => `"${step.title}" was retried before: ${step.feedback!.slice(0, 600)}`) : [];
  conversation.messages.push(newMessage({
    role: 'assistant',
    text: [
      `Moved from the Agent task "${task.title}" (${task.id}, ${task.createdAt.slice(0, 10)}), for the repository ${task.repositoryRoot}. ${status}`.trim(),
      task.branch ? `Its branch: ${task.branch}.${plan ? ' The steps below work on it: switch to it before Run.' : ''}` : '',
      done.length ? `Done in the Agent:\n${done.map(({ step, index }) => doneLine(step, index)).join('\n')}` : '',
      reviewNote,
      plan ? `The steps not done yet are the plan below, as code steps you review.` : '',
      ...retried
    ].filter(Boolean).join('\n\n'),
    ...(plan ? { draft: { workflow: plan, problems: planProblems(plan, steps), status: 'current' as const } } : {})
  }));
  if (plan) { conversation.plan = plan; }
  return conversation;
}

/** A task left planning or running: where a person decides, with a running step's writes undone. */
export function settleInterrupted(task: AgentTask, isDirty: (absolutePath: string) => boolean): string[] {
  if (task.status === 'planning') { task.status = 'new'; return []; }
  if (task.status !== 'stepRunning') { return []; }
  const step = task.plan?.[task.current];
  const kept = revertChanges(task.repositoryRoot, step?.result?.changes ?? [], isDirty);
  if (step) { step.result = undefined; }
  task.status = 'stepReady';
  return kept;
}

/** Moves every task not moved yet; returns how many moved. */
export async function moveAgentTasks(storage: string, isDirty: (absolutePath: string) => boolean): Promise<number> {
  const tasks = new TaskStore(path.join(storage, 'agent'));
  const chats = new ChatStore(path.join(storage, 'studio', 'chats'));
  const steps = studioSteps();
  let moved = 0;
  for (const task of tasks.list()) {
    settleInterrupted(task, isDirty);
    const conversation = taskToConversation(task, chats, steps);
    await chats.save(conversation);
    task.movedTo = conversation.id;
    tasks.log(task.id, { type: 'approval', action: 'moveToStudio', detail: conversation.id });
    tasks.save(task);
    moved++;
  }
  return moved;
}
