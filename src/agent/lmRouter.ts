/* eslint-disable @typescript-eslint/naming-convention -- Anthropic-shaped messages and tools (tool_use_id, input_schema, tool names), as Musubi's LMRouter. */
/**
 * The one boundary between the agent and a model: Anthropic-shaped messages and tools in, one
 * reply out (the same boundary as Musubi's LMRouter). Each vendor converts to its own format.
 *
 * CopilotRouter talks to Copilot through vscode.lm with a JSON tool protocol (the one the review
 * engine uses), so it works on every VS Code that has vscode.lm, with or without native tool calls.
 */

import { parseModelJson } from '../services/modelJson';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the input. */
  input_schema: Record<string, unknown>;
}

export interface RouterResponse {
  /** tool_use: the content holds one tool_use block. end_turn: a text block with the final JSON. */
  stopReason: 'tool_use' | 'end_turn';
  content: ContentBlock[];
  usage: { inputTokens: number; outputTokens: number };
  modelId: string;
}

/** The part of a cancellation token the router reads (vscode.CancellationToken fits). */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => unknown): { dispose(): unknown };
}

export interface LmRouter {
  call(system: string, messages: AgentMessage[], tools: ToolSpec[], token: CancelToken): Promise<RouterResponse>;
}

/** The part of vscode.LanguageModelChat used here, so tests pass a scripted model. */
export interface CopilotChatModel {
  id: string; name: string; version: string; maxInputTokens: number;
  countTokens(value: string): Thenable<number>;
  sendRequest(messages: unknown[], options: Record<string, never>, token: unknown): Thenable<{ text: AsyncIterable<string> }>;
}

export interface CopilotApi {
  selectModel(): Promise<CopilotChatModel>;
  user(text: string): unknown;
  /** An assistant message, where the VS Code in use has one; otherwise user() is used. */
  assistant?(text: string): unknown;
}

const MAX_REPLY_CHARS = 60000;

/** The protocol text sent ahead of the instructions: how to call a tool and how to finish. */
export function toolProtocol(tools: ToolSpec[]): string {
  const list = tools.map(tool => `- ${tool.name}: ${tool.description} Input schema: ${JSON.stringify(tool.input_schema)}`).join('\n');
  return [
    'Reply with exactly ONE JSON object and nothing else (no prose, no code fence).',
    'To call a tool: {"tool": {"name": "<tool name>", "input": {...}}}. You get its result in the next message; call one tool per reply.',
    'When you are done: {"final": {...}} with the result the instructions ask for.',
    tools.length ? `Tools:\n${list}` : 'No tools are available: reply with {"final": ...} now.'
  ].join('\n');
}

const REPAIR = 'Your previous reply was not one valid JSON object of the form {"tool": {...}} or {"final": {...}}. Reply again with ONLY that JSON object.';

function render(block: ContentBlock): string {
  if (block.type === 'text') { return block.text; }
  if (block.type === 'tool_use') { return JSON.stringify({ tool: { name: block.name, input: block.input } }); }
  return JSON.stringify({ toolResult: block.is_error ? { error: block.content } : { content: block.content } });
}

export class CopilotRouter implements LmRouter {
  private counter = 0;
  constructor(private readonly api: CopilotApi) {}

  async call(system: string, messages: AgentMessage[], tools: ToolSpec[], token: CancelToken): Promise<RouterResponse> {
    const model = await this.api.selectModel();
    const texts: Array<{ role: 'user' | 'assistant'; text: string }> = [{ role: 'user', text: `${system}\n\n${toolProtocol(tools)}` }];
    for (const message of messages) {
      const text = typeof message.content === 'string' ? message.content : message.content.map(render).join('\n');
      texts.push({ role: message.role, text });
    }
    const toMessage = (item: { role: 'user' | 'assistant'; text: string }) =>
      item.role === 'assistant' && this.api.assistant ? this.api.assistant(item.text) : this.api.user(item.text);
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (token.isCancellationRequested) { throw new Error('Cancelled'); }
      const size = (await Promise.all(texts.map(item => model.countTokens(item.text)))).reduce((sum, count) => sum + count, 0);
      if (size > model.maxInputTokens - 2048) { throw new Error(`The conversation no longer fits ${model.name} (${size} tokens).`); }
      inputTokens += size;
      const response = await model.sendRequest(texts.map(toMessage), {}, token);
      let reply = '';
      for await (const part of response.text) {
        if (token.isCancellationRequested) { throw new Error('Cancelled'); }
        reply += part;
        if (reply.length > MAX_REPLY_CHARS) { throw new Error('The model reply exceeds the size limit.'); }
      }
      outputTokens += await model.countTokens(reply);
      const parsed = parseModelJson(reply);
      const modelId = `${model.id}:${model.version}`;
      const usage = { inputTokens, outputTokens };
      const tool = parsed?.tool;
      if (tool && typeof tool === 'object' && typeof (tool as { name?: unknown }).name === 'string') {
        const { name, input } = tool as { name: string; input?: unknown };
        const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
        return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: `call_${++this.counter}`, name, input: args }], usage, modelId };
      }
      if (parsed && 'final' in parsed) {
        return { stopReason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(parsed.final) }], usage, modelId };
      }
      texts.push({ role: 'assistant', text: reply }, { role: 'user', text: REPAIR });
    }
    throw new Error('The model did not answer in the required JSON format.');
  }
}
