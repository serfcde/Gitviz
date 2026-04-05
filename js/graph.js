/**
 * CommitNode — represents a single commit in the DAG.
 */
class CommitNode {
  constructor(raw) {
    this.sha        = raw.sha;
    this.shortSha   = raw.sha.substring(0, 7);
    this.message    = (raw.commit.message || '').split('\n')[0].trim();
    this.fullMessage = raw.commit.message || '';
    this.author     = raw.commit.author ? raw.commit.author.name  : 'Unknown';
    this.email      = raw.commit.author ? raw.commit.author.email : '';
    this.timestamp  = new Date(
      raw.commit.author ? raw.commit.author.date : raw.commit.committer.date
    );
    this.parents    = (raw.parents || []).map(p => p.sha);
    this.children   = [];   // filled in during DAG build
    this.branch     = null; // assigned during lane pass
    this.branchColor = '#6e7681';
    this.lane       = 0;    // horizontal position index
    this.row        = 0;    // vertical position index (0 = newest)
    this.x          = 0;
    this.y          = 0;
    this.isMerge    = this.parents.length > 1;
    this.isRoot     = this.parents.length === 0;
  }

  get formattedDate() {
    return this.timestamp.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  get formattedDateTime() {
    return this.timestamp.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }
}

/* ─────────────────────────────────────────────────────────
   CommitGraph — builds and lays out the full DAG.
   ───────────────────────────────────────────────────────── */
class CommitGraph {
  /* Layout constants */
  static LANE_W  = 26;  // px between horizontal lanes
  static ROW_H   = 44;  // px between commit rows
  static NODE_R  = 6;   // commit node radius
  static MARGIN_X = 14; // left margin
  static MARGIN_Y = 18; // top margin

  // Branch palette (index 0 = main/master)
  static PALETTE = [
    '#3fb950', // green
    '#58a6ff', // blue
    '#ff7b72', // red
    '#ffa657', // orange
    '#d2a8ff', // purple
    '#79c0ff', // sky
    '#56d364', // lime
    '#f78166', // salmon
    '#e3b341', // yellow
    '#a5d6ff', // pale blue
    '#ff9bce', // pink
    '#bc8cff', // lavender
  ];

  constructor() {
    this.commitMap   = new Map(); // sha → CommitNode
    this.commits     = [];        // sorted newest→oldest
    this.branches    = [];        // raw branch objects
    this.branchColors = {};       // name → color
    this.maxLane     = 0;
    this.totalWidth  = 0;
    this.totalHeight = 0;
  }

  /* ── Main Entry Point ────────────────────────────────── */

  build(commitsRaw, branchesRaw) {
    this._reset();
    this.branches = branchesRaw || [];

    // 1. Create nodes
    for (const raw of commitsRaw) {
      const node = new CommitNode(raw);
      this.commitMap.set(node.sha, node);
    }

    // 2. Link children
    for (const node of this.commitMap.values()) {
      for (const pSha of node.parents) {
        const parent = this.commitMap.get(pSha);
        if (parent) parent.children.push(node.sha);
      }
    }

    // 3. Sort newest-first (GitHub API already returns this order,
    //    but we re-sort to be safe)
    this.commits = [...this.commitMap.values()].sort(
      (a, b) => b.timestamp - a.timestamp
    );

    // 4. Assign row indices
    this.commits.forEach((n, i) => { n.row = i; });

    // 5. Assign branch labels to nodes (via DFS from each branch head)
    this._assignBranchLabels();

    // 6. Assign colors
    this._assignColors();

    // 7. Lane assignment (git-log-graph style)
    this._assignLanes();

    // 8. Compute pixel positions
    this._computePositions();

    return this;
  }

  /* ── Branch Label Assignment ─────────────────────────── */

  _assignBranchLabels() {
    // Prioritise main/master so it gets lane 0
    const sorted = [...this.branches].sort((a, b) => {
      const score = n => (n === 'main' ? 0 : n === 'master' ? 1 : 2);
      return score(a.name) - score(b.name);
    });

    for (const br of sorted) {
      // DFS from branch head backward through first parents
      let sha = br.commit.sha;
      const visited = new Set();
      while (sha && !visited.has(sha)) {
        visited.add(sha);
        const node = this.commitMap.get(sha);
        if (!node) break;
        if (!node.branch) {
          node.branch = br.name;
        }
        // Follow first parent
        sha = node.parents[0] || null;
      }
    }

    // Remaining unlabelled commits get 'HEAD'
    for (const node of this.commits) {
      if (!node.branch) node.branch = 'HEAD';
    }
  }

  /* ── Color Assignment ────────────────────────────────── */

  _assignColors() {
    const sorted = [...this.branches].sort((a, b) => {
      const score = n => (n === 'main' ? 0 : n === 'master' ? 1 : 2);
      return score(a.name) - score(b.name);
    });

    let idx = 0;
    for (const br of sorted) {
      this.branchColors[br.name] = CommitGraph.PALETTE[idx % CommitGraph.PALETTE.length];
      idx++;
    }
    this.branchColors['HEAD'] = '#6e7681';

    for (const node of this.commits) {
      node.branchColor = this.branchColors[node.branch] || '#6e7681';
    }
  }

  /* ── Lane Assignment ─────────────────────────────────── */
  /**
   * Implementation mirrors the "git log --graph" algorithm:
   *  - active  : array of { sha, lane } — each entry is a "live branch line"
   *    being traced downwards from a processed commit toward its parents.
   *  - For each commit (newest → oldest):
   *    1. Find it in `active` → use that lane, OR allocate a new one.
   *    2. Remove it from `active`.
   *    3. Re-insert its parents:
   *       - first parent keeps the same lane (continuation)
   *       - additional parents (merge) get new lanes
   */
  _assignLanes() {
    // active[i] = sha expected at that lane, or null (free)
    const active = [];

    const firstFree = () => {
      const i = active.indexOf(null);
      return i !== -1 ? i : active.length;
    };

    const isActive = sha => active.findIndex(s => s === sha);

    for (const node of this.commits) {
      let lane = isActive(node.sha);

      if (lane === -1) {
        lane = firstFree();
        if (lane === active.length) active.push(null);
      }

      // Clear this slot
      active[lane] = null;
      node.lane = lane;

      // Re-insert parents
      for (let pi = 0; pi < node.parents.length; pi++) {
        const pSha = node.parents[pi];
        if (isActive(pSha) !== -1) continue; // already tracked

        if (pi === 0) {
          // First parent continues in same lane
          active[lane] = pSha;
        } else {
          // Merge sources get a new lane
          const nl = firstFree();
          if (nl === active.length) active.push(pSha);
          else active[nl] = pSha;
        }
      }
    }

    this.maxLane = Math.max(...this.commits.map(n => n.lane), 0);
  }

  /* ── Pixel Positions ─────────────────────────────────── */

  _computePositions() {
    const { LANE_W, ROW_H, MARGIN_X, MARGIN_Y } = CommitGraph;
    for (const node of this.commits) {
      node.x = MARGIN_X + (node.lane + 0.5) * LANE_W;
      node.y = MARGIN_Y + (node.row  + 0.5) * ROW_H;
    }

    const labelOffset = MARGIN_X + (this.maxLane + 1) * LANE_W + 12;
    this.labelStartX = labelOffset;

    this.totalWidth  = labelOffset + 620; // label area
    this.totalHeight = MARGIN_Y + this.commits.length * ROW_H + MARGIN_Y;
  }

  /* ── Edge Data ───────────────────────────────────────── */

  getEdges() {
    const edges = [];
    for (const node of this.commits) {
      for (let pi = 0; pi < node.parents.length; pi++) {
        const parent = this.commitMap.get(node.parents[pi]);
        if (!parent) continue;
        edges.push({
          fromNode: node,
          toNode:   parent,
          color:    pi === 0 ? node.branchColor : parent.branchColor,
          isMerge:  node.isMerge && pi > 0,
        });
      }
    }
    return edges;
  }

  /* ── Helpers ─────────────────────────────────────────── */

  _reset() {
    this.commitMap.clear();
    this.commits = [];
    this.branches = [];
    this.branchColors = {};
    this.maxLane = 0;
  }
}
