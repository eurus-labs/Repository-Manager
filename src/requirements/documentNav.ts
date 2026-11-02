/**
 * Where each requirement document sits in the documentation's own navigation: the Sphinx
 * toctrees (RST `.. toctree::`, MyST ```{toctree}```) and the titles of the documents they list,
 * as the built site's side bar shows them ("Reprog Indus - Requirements › Reprog Indus - HexOgen").
 *
 * The top documents are the ones no toctree lists. One whose toctrees have captions is the site's
 * start page: like Sphinx's side bar, its own title is left out and its captions are shown
 * instead. A document no toctree reaches has no place; the side bar then groups it by folder.
 * No `vscode` here, so tests run in Node.
 */
import * as path from 'path';

export interface Toctree { caption?: string; glob: boolean; entries: string[] }
export interface NavDocument { title: string; toctrees: Toctree[] }
/** One level of a place: its title, and where it comes in the navigation (to keep that order). */
export type PlaceStep = [title: string, order: number];

const ADORNMENT = /^([=\-~^"'`*+#:._])\1{2,}\s*$/;

/** The document's title: its first RST section title. */
function rstTitle(lines: string[]): string {
  for (let i = 0; i < lines.length - 1; i++) {
    const text = lines[i].trimEnd(), under = lines[i + 1].trimEnd();
    if (!text.trim() || text.startsWith(' ') || ADORNMENT.test(text) || !ADORNMENT.test(under)) { continue; }
    if ([...under].length >= Math.min([...text.trim()].length, 4)) { return text.trim(); }
  }
  return '';
}

/** The body of a directive: options first (":caption: X"), then its entries, one per line. */
function toctreeFrom(body: string[]): Toctree {
  const tree: Toctree = { glob: false, entries: [] };
  let options = true;
  for (const raw of body) {
    const line = raw.trim();
    if (!line) { options = false; continue; }
    const option = options ? /^:([\w-]+):\s*(.*)$/.exec(line) : null;
    if (option) {
      if (option[1] === 'caption') { tree.caption = option[2].trim(); }
      if (option[1] === 'glob') { tree.glob = true; }
      continue;
    }
    options = false;
    if (!line.startsWith('..')) { tree.entries.push(line); }
  }
  return tree;
}

export function navDocument(content: string, suffix: string): NavDocument {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const toctrees: Toctree[] = [];
  if (suffix.toLowerCase() === '.rst') {
    lines.forEach((line, at) => {
      const directive = /^(\s*)\.\.\s+toctree::\s*$/.exec(line);
      if (!directive) { return; }
      const indent = directive[1].length;
      const body: string[] = [];
      for (const next of lines.slice(at + 1)) {
        if (next.trim() && next.length - next.trimStart().length <= indent) { break; }
        body.push(next);
      }
      toctrees.push(toctreeFrom(body));
    });
    return { title: rstTitle(lines), toctrees };
  }
  // Markdown (MyST): a ```{toctree} fence, and the first "# " heading.
  let title = '';
  for (let at = 0; at < lines.length; at++) {
    const fence = /^\s*(`{3,}|:{3,})\{toctree\}\s*$/.exec(lines[at]);
    if (fence) {
      const close = lines.findIndex((line, n) => n > at && line.trim() === fence[1]);
      toctrees.push(toctreeFrom(lines.slice(at + 1, close < 0 ? lines.length : close)));
      at = close < 0 ? lines.length : close;
      continue;
    }
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(lines[at]);
    if (heading && !title) { title = heading[1]; }
  }
  return { title, toctrees };
}

/** The document name of a file: its path without the extension. */
export const documentName = (file: string): string => file.replace(/\.(rst|md)$/i, '');

function globPattern(glob: string): RegExp {
  // "**" crosses folders, "*" and "?" do not.
  const escaped = glob.replace(/[.+^${}()|\\]/g, '\\$&').split('**')
    .map(part => part.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('.*');
  return new RegExp(`^${escaped}$`);
}

/** The documents an entry names: "doc", "Title <doc>", "/from/the/root", or a glob with :glob:. */
function resolve(entry: string, from: string, glob: boolean, sourceRoot: string, names: string[]): string[] {
  const titled = /^(.*?)\s*<([^<>]+)>$/.exec(entry);
  const target = documentName((titled ? titled[2] : entry).trim());
  if (!target || target === 'self' || /^[a-z][a-z0-9+.-]*:/i.test(target)) { return []; }
  const joined = path.posix.normalize(target.startsWith('/') ? path.posix.join(sourceRoot, target.slice(1)) : path.posix.join(path.posix.dirname(from), target));
  if (glob && /[*?]/.test(target)) {
    const pattern = globPattern(joined);
    return names.filter(name => name !== from && pattern.test(name)).sort();
  }
  return names.includes(joined) ? [joined] : [];
}

/**
 * Each document's place in the navigation, by document name (see documentName). `sourceRoot` is
 * the folder "/" entries start from, in the same terms as the names.
 */
export function documentPlaces(documents: Map<string, NavDocument>, sourceRoot: string): Map<string, PlaceStep[]> {
  const names = [...documents.keys()].sort();
  const children = new Map<string, Array<{ caption?: string; docs: string[] }>>();
  const listed = new Set<string>();
  for (const name of names) {
    const trees = documents.get(name)!.toctrees.map(tree => ({
      caption: tree.caption,
      docs: tree.entries.flatMap(entry => resolve(entry, name, tree.glob, sourceRoot, names)).filter(doc => doc !== name)
    }));
    children.set(name, trees);
    trees.forEach(tree => tree.docs.forEach(doc => listed.add(doc)));
  }
  const places = new Map<string, PlaceStep[]>();
  let order = 0;
  const title = (name: string) => documents.get(name)!.title || path.posix.basename(name);
  // Tops: documents with toctrees that no toctree lists. A document only listed from below it (a
  // toctree pointing back up) is a top too once no other top reaches it, shallowest first.
  const hasTree = (name: string) => children.get(name)!.some(tree => tree.docs.length);
  const depth = (name: string) => name.split('/').length;
  const tops = names.filter(name => !listed.has(name) && hasTree(name));
  const next = () => tops.shift() ?? names.filter(name => hasTree(name) && !places.has(name)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];
  for (let root = next(); root; root = next()) {
    if (places.has(root)) { continue; }
    // The site's start page: its captions stand for it, as in Sphinx's side bar.
    const start = documents.get(root)!.toctrees.some(tree => tree.caption);
    places.set(root, start ? [] : [[title(root), order++]]);
    const queue = [root];
    while (queue.length) {
      const name = queue.shift()!;
      const at = places.get(name)!;
      for (const tree of children.get(name)!) {
        const caption: PlaceStep[] = name === root && start && tree.caption ? [[tree.caption, order++]] : [];
        for (const doc of tree.docs) {
          if (places.has(doc)) { continue; }
          places.set(doc, [...at, ...caption, [title(doc), order++]]);
          queue.push(doc);
        }
      }
    }
  }
  for (const [name, place] of places) { if (!place.length) { places.delete(name); } }
  return places;
}
