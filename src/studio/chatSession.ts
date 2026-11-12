/**
 * What each action in the Studio Chat does to a conversation: a turn adds the person's message
 * and the model's reply; the first plan becomes the conversation's plan; a later one waits as a
 * proposed change until the person accepts it; edits on the plan card change the plan. Kept apart
 * from the view so the rules are tested without VS Code. No `vscode` here.
 */
import { diffIsEmpty, PlanDraft, planProblems } from './chatPlanner';
import { ChatMessage, ChatRun, Conversation, newMessage } from './chatStore';
import { StepDefinition } from './steps';
import { applyEdit, EditOperation } from './workflowEdit';
import { runOrder, Workflow } from './workflow';

export class ChatError extends Error {}

const TITLE_CHARS = 60;

/** The card that holds the conversation's plan now, if any. */
export function currentCard(conversation: Conversation): ChatMessage | undefined {
  return [...conversation.messages].reverse().find(message => message.draft?.status === 'current');
}

export function addUserMessage(conversation: Conversation, text: string): ChatMessage {
  const message = newMessage({ role: 'user', text: text.trim() });
  conversation.messages.push(message);
  if (conversation.title === 'New chat') { conversation.title = text.trim().length > TITLE_CHARS ? `${text.trim().slice(0, TITLE_CHARS - 1)}…` : text.trim(); }
  return message;
}

/** Records the model's turn. Returns the message added. */
export function addDraft(conversation: Conversation, draft: PlanDraft): ChatMessage {
  if (!draft.workflow) {
    const failed = !draft.reply && draft.problems.length;
    const message = failed
      ? newMessage({ role: 'error', text: `The model's reply could not be used: ${draft.problems.map(problem => problem.message).join(' ')} Try again, or rephrase.`, model: draft.model })
      : newMessage({ role: 'assistant', text: draft.reply, model: draft.model });
    conversation.messages.push(message);
    return message;
  }
  // A "change" that changes nothing is a reply, not a card to accept.
  if (conversation.plan && draft.diff && diffIsEmpty(draft.diff)) {
    const message = newMessage({ role: 'assistant', text: draft.reply || 'The plan stays as it is.', model: draft.model });
    conversation.messages.push(message);
    return message;
  }
  for (const message of conversation.messages) {
    if (message.draft?.status === 'proposed') { message.draft.status = 'superseded'; }
  }
  const first = !conversation.plan;
  const message = newMessage({
    role: 'assistant', text: draft.reply, model: draft.model,
    draft: { workflow: draft.workflow, problems: draft.problems, diff: first ? undefined : draft.diff, status: first ? 'current' : 'proposed' }
  });
  conversation.messages.push(message);
  if (first) { conversation.plan = draft.workflow; }
  return message;
}

function proposal(conversation: Conversation, id: string): ChatMessage {
  const message = conversation.messages.find(candidate => candidate.id === id);
  if (!message?.draft) { throw new ChatError('That plan is no longer in this chat.'); }
  if (message.draft.status !== 'proposed') { throw new ChatError('Only the latest proposed change can be accepted or discarded.'); }
  return message;
}

/** The proposed change becomes the plan; the card that held the plan before is kept as history. */
export function acceptDraft(conversation: Conversation, id: string): Workflow {
  const message = proposal(conversation, id);
  const before = currentCard(conversation);
  if (before?.draft) { before.draft.status = 'superseded'; }
  message.draft!.status = 'current';
  conversation.plan = message.draft!.workflow;
  return conversation.plan;
}

export function discardDraft(conversation: Conversation, id: string): void {
  proposal(conversation, id).draft!.status = 'discarded';
}

/** An edit on the plan card (a criterion, a step's model): applied to the plan and its card. */
export function editPlan(conversation: Conversation, operation: EditOperation, steps: Map<string, StepDefinition>): Workflow {
  if (!conversation.plan) { throw new ChatError('There is no plan to edit yet.'); }
  if (!['setCriteria', 'setDefaultModel', 'setNode', 'setSkills'].includes(operation.op) || (operation.op === 'setNode' && operation.field !== 'model')) {
    throw new ChatError('The plan card changes criteria, models and skills; open the plan in the diagram for anything else.');
  }
  const plan = applyEdit(conversation.plan, operation, type => steps.get(type)?.required ?? []);
  setPlan(conversation, plan, steps);
  return plan;
}

/** The plan as it now is (after an edit, or read back from its saved file), on its card too. */
export function setPlan(conversation: Conversation, plan: Workflow, steps: Map<string, StepDefinition>): void {
  conversation.plan = plan;
  const card = currentCard(conversation);
  if (card?.draft) { card.draft.workflow = plan; card.draft.problems = planProblems(plan, steps); }
}

export function addRun(conversation: Conversation, run: ChatRun, text: string): ChatMessage {
  const message = newMessage({ role: 'run', text, run });
  conversation.messages.push(message);
  return message;
}

/** The turns the planner is given as history: what was said, not the plans (it gets the current plan). */
export function history(conversation: Conversation): Array<{ role: 'user' | 'assistant'; text: string }> {
  return conversation.messages.filter(message => (message.role === 'user' || message.role === 'assistant') && message.text)
    .map(message => ({ role: message.role as 'user' | 'assistant', text: message.text }));
}

export interface StepView {
  id: string;
  title: string;
  type: string;
  /** What the engine will ask before it: a gate waits; write, command and external ask first. */
  effect: 'read' | 'write' | 'command' | 'external' | 'gate' | 'code' | 'unknown';
  usesModel: boolean;
  model?: string;
  skills: string[];
}

/** A plan as its card shows it: the steps in the order they run, with what each one asks. */
export function planView(plan: Workflow, steps: Map<string, StepDefinition>): { title: string; criteria: string[]; defaultModel?: string; steps: StepView[] } {
  const nodes = Array.isArray(plan.nodes) ? plan.nodes.filter(node => node && typeof node.id === 'string') : [];
  let order: string[];
  try { order = runOrder(plan); } catch { order = []; }
  const ordered = [...order.map(id => nodes.find(node => node.id === id)!).filter(Boolean), ...nodes.filter(node => !order.includes(node.id))];
  return {
    title: typeof plan.title === 'string' ? plan.title : '',
    criteria: Array.isArray(plan.criteria) ? plan.criteria.filter(item => typeof item === 'string') : [],
    defaultModel: plan.defaults?.model,
    steps: ordered.map(node => {
      const step = steps.get(node.type);
      return {
        id: node.id, title: node.title || step?.title || node.id, type: node.type,
        effect: !step ? 'unknown' : node.type === 'gate' ? 'gate' : step.review ? 'code' : step.effect,
        usesModel: Boolean(step?.usesModel), model: node.model,
        skills: Array.isArray(node.skills) ? node.skills.filter(ref => typeof ref === 'string') : []
      };
    })
  };
}
