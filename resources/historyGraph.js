(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RepositoryHistoryGraph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ROW_HEIGHT = 30;
  const LANE_GAP = 18;
  const LANE_INSET = 18;
  const MIN_GRAPH_WIDTH = 76;

  function laneX(lane) {
    return LANE_INSET + (lane * LANE_GAP);
  }

  // The commit HEAD points at: the current branch's ref, or a bare "HEAD" when detached.
  function findHeadHash(commits) {
    const head = commits.find(commit => (commit.refs || []).some(ref => ref && (ref.isCurrent || ref.name === 'HEAD')));
    return head ? head.hash : '';
  }

  // The current branch's configured upstream (`@{upstream}`, resolved by the extension) when it
  // is ahead of HEAD and its first-parent line runs straight down to HEAD: the main column then
  // starts at the upstream tip, so "behind by n" reads as one line, as in Git Graph. Nothing is
  // guessed from branch names, and a diverged upstream is left in its own column.
  function findUpstreamTip(commits, byHash, headHash, upstream) {
    if (!upstream || !headHash) return '';
    const tip = commits.find(commit => commit.hash !== headHash && (commit.refs || []).some(ref =>
      ref && ref.name === upstream && (ref.kind === 'remote-branch' || ref.kind === 'local-branch')));
    const seen = new Set();
    for (let hash = tip && tip.hash; hash && byHash.has(hash) && !seen.has(hash);) {
      if (hash === headHash) return tip.hash;
      seen.add(hash);
      hash = (byHash.get(hash).parentHashes || [])[0];
    }
    return '';
  }

  const TONE_COUNT = 8;

  // A stable tone (1-7) for a branch name, so a branch keeps its colour across pages and refreshes.
  // Tone 0 is HEAD's line: a name never takes it, so no other branch looks checked out.
  function toneForName(name) {
    let hash = 5381;
    for (let index = 0; index < name.length; index += 1) hash = ((hash * 33) + name.charCodeAt(index)) >>> 0;
    return 1 + (hash % (TONE_COUNT - 1));
  }

  // The branch a label stands for: a local branch's own name, a remote branch's name without its
  // remote (`origin/x` is `x`, so both share a tone). `origin/HEAD` is a pointer and tags are not
  // branches: they have none. '' when the label is not a branch.
  function branchNameOfRef(ref) {
    if (!ref || !ref.name) return '';
    if (ref.kind === 'head' || ref.kind === 'local-branch') return ref.name;
    if (ref.kind === 'remote-branch') {
      const separator = ref.name.indexOf('/');
      const name = separator >= 0 ? ref.name.slice(separator + 1) : ref.name;
      return name === 'HEAD' ? '' : name;
    }
    return '';
  }

  // The name that colours a lane starting at this commit: its first local branch, else its first remote one.
  function laneNameOf(commit) {
    const refs = (commit && commit.refs) || [];
    const local = refs.find(ref => ref && (ref.kind === 'head' || ref.kind === 'local-branch') && ref.name);
    if (local) return local.name;
    const remote = refs.map(branchNameOfRef).find(Boolean);
    return remote || '';
  }

  // The branch a merge commit's subject says it merged, without its remote or owner; '' when it says none.
  function mergedBranchName(subject) {
    const text = typeof subject === 'string' ? subject : '';
    const stripFirst = value => { const separator = value.indexOf('/'); return separator >= 0 ? value.slice(separator + 1) : value; };
    let match = /^Merge branch '([^']+)'/.exec(text);
    if (match) return match[1];
    match = /^Merge remote-tracking branch '([^']+)'/.exec(text);
    if (match) return stripFirst(match[1]);
    match = /^Merge pull request #\d+ from (\S+)/.exec(text);
    return match ? stripFirst(match[1]) : '';
  }

  /**
   * Lays commits (newest first) out in lanes, Git Graph style: the current branch's first-parent
   * chain stays in column 0, and every branch path keeps one column and one colour from its tip
   * until it merges or ends. Freed columns are reused. A lane's colour comes from the name of the
   * branch label where it starts (see toneForName), so it does not depend on what is loaded above;
   * an unnamed lane takes a tone its neighbouring lanes do not use. A lane a merge opens for its
   * second or later parent is named by the merge's subject (`Merge branch 'x'`), else by the
   * parent's hash, never by labels that may not be loaded. With `options.firstParent` only each
   * commit's first parent is followed (one column), and column 0 holds the chain from the first
   * commit of the list, not HEAD's.
   *
   * Per row: `lane`/`color` of the commit; `before`/`after` the hash each lane expects above and
   * below the row, with `beforeColors`/`afterColors`; `incomingLanes`, other lanes that end at this
   * commit (its other children); `parentLanes`/`parentColors`, where the edges to its parents go.
   * `segment` ids one branch line from its start to where it merges or ends, with
   * `beforeSegments`/`afterSegments`/`parentSegments` beside the colour arrays.
   */
  function buildGraphModel(commits, options) {
    const list = commits || [];
    const byHash = new Map(list.map(commit => [commit.hash, commit]));
    const headHash = (options && options.headHash) || findHeadHash(list);
    const headChain = new Set();
    const firstParentOnly = Boolean(options && options.firstParent);
    const chainTip = firstParentOnly && list.length
      ? list[0].hash
      : findUpstreamTip(list, byHash, headHash, options && options.upstream) || headHash;
    for (let hash = chainTip; hash && byHash.has(hash) && !headChain.has(hash);) {
      headChain.add(hash);
      hash = (byHash.get(hash).parentHashes || [])[0];
    }
    const reserved = headChain.size > 0;
    const lanes = [];
    const colors = [];
    const segments = [];
    let nextSegment = 0;
    let maxLaneCount = 1;
    // A tone for a lane at this column: the branch label's, else one its neighbours do not use.
    const toneFor = (commit, lane) => {
      const name = laneNameOf(commit);
      if (name) return toneForName(name);
      const used = new Set([lane - 1, lane + 1].filter(index => index >= 0 && lanes[index]).map(index => colors[index]));
      const candidates = [1, 2, 3, 4, 5, 6, 7, 0];
      return candidates.find(tone => !used.has(tone) && (tone !== 0 || !reserved)) ?? candidates.find(tone => !used.has(tone)) ?? 1;
    };
    // Column 0's tone: 0 when the chain holds HEAD, else its tip's label.
    const chainColor = headChain.has(headHash) || !list.length ? 0 : toneFor(list[0], 0);
    const freeLane = () => {
      for (let index = reserved ? 1 : 0; ; index += 1) if (!lanes[index]) return index;
    };
    const open = (lane, hash, color) => {
      lanes[lane] = hash;
      colors[lane] = color;
      segments[lane] = nextSegment++;
    };

    const rows = list.map((commit, rowIndex) => {
      const onHead = headChain.has(commit.hash);
      const expecting = [];
      lanes.forEach((value, index) => { if (value === commit.hash) expecting.push(index); });
      const lane = onHead ? 0 : expecting.length ? expecting[0] : freeLane();
      const startsHere = !expecting.includes(lane);
      if (startsHere) {
        colors[lane] = onHead ? chainColor : toneFor(commit, lane);
        segments[lane] = nextSegment++;
      }
      const before = lanes.slice();
      const beforeColors = colors.slice();
      const beforeSegments = segments.slice();
      const incomingLanes = expecting.filter(index => index !== lane);
      incomingLanes.forEach(index => { lanes[index] = null; });
      const color = colors[lane];
      const segment = segments[lane];

      const allParents = Array.isArray(commit.parentHashes) ? commit.parentHashes : [];
      const parents = firstParentOnly ? allParents.slice(0, 1) : allParents;
      const parentLanes = [];
      const parentColors = [];
      const parentSegments = [];
      if (parents.length === 0) {
        lanes[lane] = null;
      } else {
        const first = parents[0];
        const other = lanes.findIndex((value, index) => index !== lane && value === first);
        if (!onHead && other >= 0) {
          // Another lane already leads to this parent: this branch ends by joining it.
          lanes[lane] = null;
          parentLanes.push(other);
          parentColors.push(color);
          parentSegments.push(segment);
        } else {
          lanes[lane] = first;
          parentLanes.push(lane);
          parentColors.push(color);
          parentSegments.push(segment);
        }
        parents.slice(1).forEach(parentHash => {
          let parentLane = lanes.indexOf(parentHash);
          if (parentLane < 0) {
            // Even a commit of the current branch opens its own lane here; when its row comes it
            // is drawn in column 0 and this lane curves into it.
            parentLane = freeLane();
            open(parentLane, parentHash, toneForName(mergedBranchName(commit.subject) || parentHash));
          }
          parentLanes.push(parentLane);
          parentColors.push(colors[parentLane]);
          parentSegments.push(segments[parentLane]);
        });
      }

      while (lanes.length && !lanes[lanes.length - 1]) { lanes.pop(); colors.length = lanes.length; segments.length = lanes.length; }
      maxLaneCount = Math.max(maxLaneCount, before.length, lanes.length, lane + 1, ...parentLanes.map(value => value + 1));
      return {
        rowIndex,
        lane,
        color,
        before,
        after: lanes.slice(),
        beforeColors,
        afterColors: colors.slice(),
        segment,
        beforeSegments,
        afterSegments: segments.slice(),
        incomingLanes,
        parentLanes,
        parentColors,
        parentSegments,
        startsHere,
        isMerge: allParents.length > 1,
        isHead: commit.hash === headHash
      };
    });

    return {
      rows,
      laneCount: maxLaneCount,
      width: Math.max(MIN_GRAPH_WIDTH, (LANE_INSET * 2) + ((maxLaneCount - 1) * LANE_GAP)),
      height: rows.length * ROW_HEIGHT,
      rowHeight: ROW_HEIGHT
    };
  }

  function toggleCompareSelection(selection, commitHash) {
    const next = Array.isArray(selection) ? selection.filter(Boolean).slice(0, 2) : [];
    const selectedIndex = next.indexOf(commitHash);
    if (selectedIndex >= 0) {
      next.splice(selectedIndex, 1);
      return next;
    }
    if (next.length === 2) next.shift();
    next.push(commitHash);
    return next;
  }

  function transitionCompareSelection(selection, commitHash, comparisonActive) {
    const current = Array.isArray(selection) ? selection.filter(Boolean).slice(0, 2) : [];
    const selectedIndex = current.indexOf(commitHash);
    let nextSelection;
    if (selectedIndex >= 0) {
      nextSelection = current.slice();
      nextSelection.splice(selectedIndex, 1);
    } else if (current.length < 2) {
      nextSelection = current.concat(commitHash);
    } else {
      nextSelection = [commitHash];
    }
    return {
      selection: nextSelection,
      action: nextSelection.length === 2 ? 'compare' : comparisonActive ? 'parent' : 'none'
    };
  }

  function normalizeHistoryFilters(saved) {
    const value = saved && typeof saved === 'object' ? saved : {};
    return {
      branch: typeof value.branch === 'string' ? value.branch : '',
      includeRemotes: value.includeRemotes !== false,
      search: typeof value.search === 'string' ? value.search : '',
      firstParent: value.firstParent === true
    };
  }

  return {
    ROW_HEIGHT,
    laneX,
    toneForName,
    branchNameOfRef,
    buildGraphModel,
    toggleCompareSelection,
    transitionCompareSelection,
    normalizeHistoryFilters
  };
});
