/**
 * Every step the Studio offers: the built-in ones (steps.ts) and the code step (codeStep.ts),
 * kept apart so steps.ts does not import the agent's tools. No `vscode` here.
 */
import { codeStep } from './codeStep';
import { StepDefinition, stepRegistry } from './steps';

export function studioSteps(): Map<string, StepDefinition> {
  return stepRegistry([codeStep]);
}
