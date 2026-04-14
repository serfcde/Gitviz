/**
 * CommitNode — represents a single commit in the DAG.
 */
class CommitNode {
  constructor(raw) {
    this.sha         = raw.sha;
    this.shortSha    = raw.sha.substring(0, 7);
    this.message     = (raw.commit.message || '').split('\n')[0].trim();
    this.fullMessage = raw.commit.message || '';
    this.author      = raw.commit.author  ? raw.commit.author.name  : 'Unknown';
    this.email       = raw.commit.author  ? raw.commit.author.email : '';
    this.timestamp   = new Date(
      raw.commit.author ? raw.commit.author.date : raw.commit.committer.date
    );
    this.parents     = (raw.parents || []).map(p => p.sha);
    this.children    = [];    // filled during DAG build
    this.branch      = null;  // assigned during lane pass
    this.branchColor = '#6e7681';
    this.lane        = 0;     // horizontal lane index
    this.row         = 0;     // vertical row index (0 = newest)
    this.x           = 0;
    this.y           = 0;
    this.isMerge     = this.parents.length > 1;
    this.isRoot      = this.parents.length === 0;

    // File churn tracking (populated lazily via fetchCommitDetail)
    this.fileChanges    = null; // null = not yet loaded; [] = loaded but empty
    this.churnScore     = 0;    // total lines added + deleted
    this.filesChanged   = 0;    // count of files touched
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
  static LANE_W   = 26;  // px between horizontal lanes
  static ROW_H    = 44;  // px between commit rows
  static NODE_R   = 6;   // commit node radius
  static MARGIN_X = 14;  // left margin
  static MARGIN_Y = 18;  // top margin

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
    this.commitMap    = new Map(); // sha → CommitNode — O(1) lookup
    this.commits      = [];        // sorted newest→oldest
    this.branches     = [];        // raw branch objects
    this.branchColors = {};        // name → color
    this.maxLane      = 0;
    this.totalWidth   = 0;
    this.totalHeight  = 0;
    // File churn: sha → churnScore (populated after detail fetches)
    this._churnMap    = new Map();
  }

  /* ── Main Entry Point ────────────────────────────────── */

  /**
   * Builds the DAG from raw API data.
   * Handles partial data gracefully: missing parent refs are skipped.
   */
  build(commitsRaw, branchesRaw) {
    this._reset();
    this.branches = branchesRaw || [];

    // 1. Create nodes
    for (const raw of commitsRaw) {
      try {
        const node = new CommitNode(raw);
        this.commitMap.set(node.sha, node);
      } catch (e) {
        // Skip malformed commit entries gracefully (TCEH-09)
        console.warn('Skipping malformed commit:', e);
      }
    }

    // 2. Link children (bidirectional adjacency list)
    for (const node of this.commitMap.values()) {
      for (const pSha of node.parents) {
        const parent = this.commitMap.get(pSha);
        if (parent) parent.children.push(node.sha);
        // If parent not in window, skip silently — partial data OK
      }
    }

    // 3. Topological sort (Kahn's algorithm: BFS from roots)
    //    Guarantees no child appears before parent (TCCG-06)
    this.commits = this._topologicalSort();

    // 4. Assign row indices
    this.commits.forEach((n, i) => { n.row = i; });

    // 5. Assign branch labels via DFS from each branch head
    this._assignBranchLabels();

    // 6. Assign colors
    this._assignColors();

    // 7. Lane assignment (git-log-graph algorithm)
    this._assignLanes();

    // 8. Compute pixel positions
    this._computePositions();

    return this;
  }

  /* ── Topological Sort (Kahn's BFS) ──────────────────── */

  _topologicalSort() {
    // In-degree = number of parents within our commitMap
    const inDegree = new Map();
    for (const node of this.commitMap.values()) {
      const knownParents = node.parents.filter(p => this.commitMap.has(p));
      inDegree.set(node.sha, knownParents.length);
    }

    // Queue starts with nodes that have no in-window parents (roots / boundary)
    const queue = [];
    for (const [sha, deg] of inDegree) {
      if (deg === 0) queue.push(this.commitMap.get(sha));
    }

    // Sort queue by timestamp descending so newest commits come first in output
    queue.sort((a, b) => b.timestamp - a.timestamp);

    const sorted = [];
    while (queue.length > 0) {
      // Pick the node with the latest timestamp among ready nodes
      queue.sort((a, b) => b.timestamp - a.timestamp);
      const node = queue.shift();
      sorted.push(node);

      for (const childSha of node.children) {
        const child = this.commitMap.get(childSha);
        if (!child) continue;
        const newDeg = inDegree.get(childSha) - 1;
        inDegree.set(childSha, newDeg);
        if (newDeg === 0) queue.push(child);
      }
    }

    // If cycle detected (shouldn't happen in valid Git DAG), append remaining
    if (sorted.length < this.commitMap.size) {
      const visited = new Set(sorted.map(n => n.sha));
      for (const node of this.commitMap.values()) {
        if (!visited.has(node.sha)) sorted.push(node);
      }
    }

    return sorted;
  }

  /* ── Branch Label Assignment ─────────────────────────── */

  _assignBranchLabels() {
    const sorted = [...this.branches].sort((a, b) => {
      const score = n => (n === 'main' ? 0 : n === 'master' ? 1 : 2);
      return score(a.name) - score(b.name);
    });

    for (const br of sorted) {
      let sha = br.commit.sha;
      const visited = new Set();
      while (sha && !visited.has(sha)) {
        visited.add(sha);
        const node = this.commitMap.get(sha);
        if (!node) break;
        if (!node.branch) node.branch = br.name;
        sha = node.parents[0] || null; // follow first parent
      }
    }

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
      this.branchColors[br.name] =
        CommitGraph.PALETTE[idx % CommitGraph.PALETTE.length];
      idx++;
    }
    this.branchColors['HEAD'] = '#6e7681';

    for (const node of this.commits) {
      node.branchColor = this.branchColors[node.branch] || '#6e7681';
    }
  }

  /* ── Lane Assignment ─────────────────────────────────── */
  /**
   * Mirrors git log --graph lane-tracking algorithm.
   * active[i] = sha expected at lane i, or null (free).
   */
  _assignLanes() {
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

      active[lane] = null;
      node.lane = lane;

      for (let pi = 0; pi < node.parents.length; pi++) {
        const pSha = node.parents[pi];
        if (isActive(pSha) !== -1) continue;

        if (pi === 0) {
          active[lane] = pSha; // first parent: continue same lane
        } else {
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

    this.labelStartX = MARGIN_X + (this.maxLane + 1) * LANE_W + 12;
    this.totalWidth  = this.labelStartX + 620;
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

  /* ── File Churn Tracking ─────────────────────────────── */

  /**
   * Record file-change data for a commit once a detail fetch completes.
   * Enables cross-commit hotspot identification (TC-FE-08, TC-FE-10).
   */
  recordFileChanges(sha, files) {
    const node = this.commitMap.get(sha);
    if (!node) return;

    node.fileChanges  = files;
    node.filesChanged = files.length;
    node.churnScore   = files.reduce(
      (s, f) => s + (f.additions || 0) + (f.deletions || 0), 0
    );

    // Update per-file churn map
    for (const f of files) {
      const prev = this._churnMap.get(f.filename) || { count: 0, churn: 0 };
      this._churnMap.set(f.filename, {
        count: prev.count + 1,
        churn: prev.churn + (f.additions || 0) + (f.deletions || 0)
      });
    }
  }

  /**
   * Returns files sorted by total churn (most changed first).
   * Used for development hotspot identification.
   */
  getHotspots(topN = 20) {
    return [...this._churnMap.entries()]
      .sort((a, b) => b[1].churn - a[1].churn)
      .slice(0, topN)
      .map(([filename, stats]) => ({ filename, ...stats }));
  }

  /**
   * Returns true if a filename is a hotspot (top-10% churn).
   */
  isHotspot(filename) {
    if (this._churnMap.size === 0) return false;
    const entry = this._churnMap.get(filename);
    if (!entry) return false;
    const hotspots = this.getHotspots(Math.ceil(this._churnMap.size * 0.1) || 3);
    return hotspots.some(h => h.filename === filename);
  }

  /* ── Helpers ─────────────────────────────────────────── */

  _reset() {
    this.commitMap.clear();
    this.commits = [];
    this.branches = [];
    this.branchColors = {};
    this.maxLane = 0;
    this._churnMap.clear();
  }
}
