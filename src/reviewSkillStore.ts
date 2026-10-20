/**
 * The review skills available to every review: the ones shipped in resources/review-skills, plus
 * the ones the user imported, minus the ones turned off. Imported skills and the off list are kept
 * in global state, so they follow the user across workspaces; nothing is read from the repository.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MementoLike } from './reviewConsent';
import { parseReviewSkill, ReviewSkill } from './services/reviewSkills';

const IMPORTED_KEY = 'repositoryManager.reviewSkills.imported';
const DISABLED_KEY = 'repositoryManager.reviewSkills.disabled';
const MAX_IMPORTED = 30;

export interface ReviewSkillSummary {
  id: string;
  name: string;
  category: ReviewSkill['category'];
  appliesTo: string[];
  references: string;
  source: ReviewSkill['source'];
  enabled: boolean;
}

export interface ReviewSkillSnapshot {
  skills: ReviewSkill[];
  disabled: Set<string>;
}

export class ReviewSkillStore {
  private bundled?: ReviewSkill[];

  constructor(private readonly bundledDir: string, private readonly memento?: MementoLike) {}

  private loadBundled(): ReviewSkill[] {
    if (!this.bundled) {
      let files: string[] = [];
      try { files = fs.readdirSync(this.bundledDir).filter(name => name.endsWith('.md')).sort(); } catch { files = []; }
      this.bundled = files.map(name => parseReviewSkill(fs.readFileSync(path.join(this.bundledDir, name), 'utf8'), 'bundled'))
        .filter((skill): skill is ReviewSkill => typeof skill !== 'string');
    }
    return this.bundled;
  }

  private imported(): ReviewSkill[] {
    const value = this.memento?.get<unknown>(IMPORTED_KEY);
    return Array.isArray(value) ? value.filter((skill): skill is ReviewSkill =>
      Boolean(skill && typeof skill.id === 'string' && typeof skill.guidance === 'string' && Array.isArray(skill.appliesTo))) : [];
  }

  private disabledIds(): Set<string> {
    const value = this.memento?.get<unknown>(DISABLED_KEY);
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  }

  /** What a review uses: an imported skill replaces a bundled one with the same id. */
  snapshot(): ReviewSkillSnapshot {
    const imported = this.imported();
    const ids = new Set(imported.map(skill => skill.id));
    return { skills: [...this.loadBundled().filter(skill => !ids.has(skill.id)), ...imported], disabled: this.disabledIds() };
  }

  list(): ReviewSkillSummary[] {
    const { skills, disabled } = this.snapshot();
    return skills.map(skill => ({ id: skill.id, name: skill.name, category: skill.category, appliesTo: skill.appliesTo,
      references: skill.references, source: skill.source, enabled: !disabled.has(skill.id) }));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const disabled = this.disabledIds();
    if (enabled) { disabled.delete(id); } else { disabled.add(id); }
    await this.memento?.update(DISABLED_KEY, [...disabled]);
  }

  /** Adds a skill from Markdown text, or replaces the imported one with its id. Returns an error message. */
  async import(text: string): Promise<ReviewSkill | string> {
    const skill = parseReviewSkill(text, 'imported');
    if (typeof skill === 'string') { return skill; }
    const others = this.imported().filter(item => item.id !== skill.id);
    if (others.length >= MAX_IMPORTED) { return `At most ${MAX_IMPORTED} imported skills; remove one first.`; }
    await this.memento?.update(IMPORTED_KEY, [...others, skill]);
    return skill;
  }

  /**
   * Whether reviews also check maintainability (the `quality` category): while a quality skill such
   * as clean code is on. Turning those skills off in the review tab turns the notes off.
   */
  includeQuality(): boolean {
    const { skills, disabled } = this.snapshot();
    return skills.some(skill => skill.category === 'quality' && !disabled.has(skill.id));
  }

  async remove(id: string): Promise<void> {
    await this.memento?.update(IMPORTED_KEY, this.imported().filter(skill => skill.id !== id));
  }
}
