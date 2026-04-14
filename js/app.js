/**
 * App — main controller.
 * Orchestrates API client, graph builder, and visualizer.
 * State machine: idle → loading → processing → visualized → error
 */
class App {
  constructor() {
    this.api        = new GitHubAPIClient();
    this.graph      = new CommitGraph();
    this.visualizer = null;
    this.state      = 'idle';
    this.currentRepo = null; // { owner, repo }
    this._fullSha   = '';    // for copy button

    this._cacheEl();
    this._initVisualizer();
    this._bindEvents();
  }

  /* ── DOM Cache ───────────────────────────────────────── */

  _cacheEl() {
    const $ = id => document.getElementById(id);

    this.el = {
      urlInput:       $('repo-url-input'),
      loadBtn:        $('load-btn'),
      rateLimit:      $('rate-limit-badge'),
      repoLabel:      $('repo-label'),
      commitCount:    $('commit-count'),

      graphSvg:       $('graph-svg'),
      emptyState:     $('empty-state'),
      loadingOverlay: $('loading-overlay'),
      loadingMsg:     $('loading-message'),
      errorOverlay:   $('error-overlay'),
      errorMsg:       $('error-message'),
      errorDismiss:   $('error-dismiss-btn'),

      zoomIn:         $('zoom-in-btn'),
      zoomOut:        $('zoom-out-btn'),
      zoomReset:      $('zoom-reset-btn'),

      legendTags:     $('legend-tags'),

      detailsIdle:    $('details-idle'),
      commitDetails:  $('commit-details'),
      cdShortHash:    $('cd-short-hash'),
      cdCopyHash:     $('cd-copy-hash'),
      cdMessage:      $('cd-message'),
      cdAuthor:       $('cd-author'),
      cdDate:         $('cd-date'),
      cdBranch:       $('cd-branch'),
      cdParents:      $('cd-parents'),
      cdMergeRow:     $('cd-merge-row'),
      cdFileStats:    $('cd-file-stats'),
      cdFileLoading:  $('cd-file-loading'),
      cdFileList:     $('cd-file-list'),
    };
  }

  /* ── Visualizer Init ─────────────────────────────────── */

  _initVisualizer() {
    this.visualizer = new GraphVisualizer(
      this.el.graphSvg,
      node => node ? this._showCommitDetails(node) : this._hideCommitDetails()
    );
  }

  /* ── Event Binding ───────────────────────────────────── */

  _bindEvents() {
    this.el.loadBtn.addEventListener('click', () => this._load());
    this.el.urlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._load();
    });

    this.el.errorDismiss.addEventListener('click', () => this._setState('idle'));

    this.el.zoomIn.addEventListener('click',    () => this.visualizer.zoomIn());
    this.el.zoomOut.addEventListener('click',   () => this.visualizer.zoomOut());
    this.el.zoomReset.addEventListener('click', () => this.visualizer.resetView());

    this.el.cdCopyHash.addEventListener('click', () => {
      if (this._fullSha) {
        navigator.clipboard.writeText(this._fullSha).catch(() => {});
        const btn = this.el.cdCopyHash;
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '⎘'; }, 1500);
      }
    });

    // Example URL buttons
    document.querySelectorAll('.example-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.el.urlInput.value = btn.dataset.url;
        this._load();
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      // Ctrl/Cmd+K → focus URL input
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.el.urlInput.focus();
        this.el.urlInput.select();
        return;
      }

      // Arrow/+/- keys → zoom/pan when graph is visible and input not focused
      if (this.state !== 'visualized') return;
      if (document.activeElement === this.el.urlInput) return;

      switch (e.key) {
        case '+':
        case '=':
          e.preventDefault();
          this.visualizer.zoomIn();
          break;
        case '-':
        case '_':
          e.preventDefault();
          this.visualizer.zoomOut();
          break;
        case '0':
          e.preventDefault();
          this.visualizer.resetView();
          break;
      }
    });

    // Resize → refit
    window.addEventListener('resize', () => {
      if (this.state === 'visualized') this.visualizer.resetView();
    });
  }

  /* ── Load Repository ─────────────────────────────────── */

  async _load() {
    const rawUrl = this.el.urlInput.value.trim();

    // Specific validation error messages (covers TCRL03–TCRL09)
    const validationErr = this.api.getValidationError(rawUrl);
    if (validationErr) {
      this._showError(validationErr);
      return;
    }

    let owner, repo;
    try { ({ owner, repo } = this.api.parseUrl(rawUrl)); }
    catch (e) { this._showError(e.message); return; }

    this._setState('loading');
    this.api.clearCache();

    try {
      /* 1 — Repo metadata */
      this._setLoadingMsg('Connecting to GitHub API…');
      const repoData = await this.api.fetchRepo(owner, repo);

      if (repoData.private) {
        throw new Error(
          'This repository is private or inaccessible. GitViz only supports public repositories.'
        );
      }

      this.currentRepo = { owner, repo };
      this.el.repoLabel.textContent = `${owner} / ${repo}`;

      /* 2 — Branches */
      this._setLoadingMsg('Fetching branches…');
      let branchesRaw = [];
      try {
        branchesRaw = await this.api.fetchBranches(owner, repo);
      } catch (e) {
        // Partial data: warn but continue (TCEH-09)
        console.warn('Branch fetch failed:', e.message);
      }

      /* 3 — Commits */
      this._setLoadingMsg('Fetching commit history (up to 300)…');
      const commitsRaw = await this.api.fetchCommits(owner, repo, 300);

      if (!commitsRaw.length) {
        throw new Error('No commits found in this repository.');
      }

      /* 4 — Build DAG */
      this._setState('processing');
      this._setLoadingMsg('Building commit graph…');
      this.graph.build(commitsRaw, branchesRaw);

      /* 5 — Render */
      this._setLoadingMsg('Rendering visualization…');
      await this._tick();
      this.visualizer.render(this.graph);

      /* 6 — Update UI chrome */
      this.el.commitCount.textContent =
        `${this.graph.commits.length} commits · ${branchesRaw.length} branches`;
      this._updateLegend();
      this._updateRateLimit();
      this._setState('visualized');

    } catch (err) {
      this._showError(err.message || 'An unexpected error occurred. Please try again.');
    }
  }

  /* ── Commit Details Panel ────────────────────────────── */

  _showCommitDetails(node) {
    this.el.detailsIdle.style.display    = 'none';
    this.el.commitDetails.classList.remove('hidden');

    this._fullSha = node.sha;
    this.el.cdShortHash.textContent  = node.shortSha;
    this.el.cdMessage.textContent    = node.message;
    this.el.cdAuthor.textContent     = `${node.author} <${node.email}>`;
    this.el.cdDate.textContent       = node.formattedDateTime;
    this.el.cdParents.textContent    =
      node.parents.length
        ? node.parents.map(s => s.slice(0, 7)).join('  ·  ')
        : 'None — root commit';

    // Branch chip
    const color = this.graph.branchColors[node.branch] || '#6e7681';
    this.el.cdBranch.innerHTML =
      `<span class="branch-tag" style="background:${color}">${node.branch || '?'}</span>`;

    // Merge badge
    this.el.cdMergeRow.style.display = node.isMerge ? '' : 'none';

    // File changes (use cache if already loaded for this node)
    this.el.cdFileStats.innerHTML     = '';
    this.el.cdFileList.innerHTML      = '';

    if (node.fileChanges !== null) {
      // Already loaded — render immediately
      this._renderFileChanges(node, node.fileChanges);
    } else {
      this.el.cdFileLoading.style.display = 'block';
      this.el.cdFileLoading.textContent   = 'Loading file changes…';
      this._loadFileChanges(node);
    }

    this._updateRateLimit();
  }

  _hideCommitDetails() {
    this.el.detailsIdle.style.display   = 'block';
    this.el.commitDetails.classList.add('hidden');
  }

  async _loadFileChanges(node) {
    if (!this.currentRepo) return;
    const { owner, repo } = this.currentRepo;

    try {
      const detail = await this.api.fetchCommitDetail(owner, repo, node.sha);
      const files  = detail.files || [];

      // Record in graph for churn tracking (TC-FE-08, TC-FE-10)
      this.graph.recordFileChanges(node.sha, files);

      this.el.cdFileLoading.style.display = 'none';
      this._renderFileChanges(node, files);
      this._updateRateLimit();

    } catch (err) {
      this.el.cdFileLoading.textContent = `Could not load file changes: ${err.message}`;
    }
  }

  _renderFileChanges(node, files) {
    this.el.cdFileLoading.style.display = 'none';

    if (!files.length) {
      this.el.cdFileList.innerHTML =
        '<p class="no-file-changes">No file changes for this commit.</p>';
      return;
    }

    // Stats row
    const add = files.reduce((s, f) => s + (f.additions || 0), 0);
    const del = files.reduce((s, f) => s + (f.deletions  || 0), 0);
    this.el.cdFileStats.innerHTML =
      `<span class="stat-chip stat-add">+${add}</span>` +
      `<span class="stat-chip stat-del">−${del}</span>` +
      `<span class="stat-chip stat-count">${files.length} files</span>`;

    // File list
    const typeMap  = { added:'A', removed:'D', modified:'M', renamed:'R', copied:'C' };
    const classMap = {
      added:'file-added', removed:'file-deleted', modified:'file-modified',
      renamed:'file-renamed', copied:'file-renamed'
    };

    const html = files.map(f => {
      const badge     = typeMap[f.status]  || 'M';
      const cls       = classMap[f.status] || 'file-modified';
      const isHot     = this.graph.isHotspot(f.filename);
      const hotBadge  = isHot
        ? '<span class="hotspot-badge" title="Development hotspot 🔥">🔥</span>'
        : '';
      const addTxt = f.additions ? `<span class="file-add">+${f.additions}</span>` : '';
      const delTxt = f.deletions ? `<span class="file-del">−${f.deletions}</span>`  : '';

      return `<div class="file-item ${cls}${isHot ? ' is-hotspot' : ''}">
        <span class="file-type-badge">${badge}</span>
        <span class="file-path" title="${f.filename}">${f.filename}</span>
        ${hotBadge}
        <span class="file-diff">${addTxt}${delTxt}</span>
      </div>`;
    }).join('');

    this.el.cdFileList.innerHTML = html;
  }

  /* ── Branch Legend ───────────────────────────────────── */

  _updateLegend() {
    const chips = this.graph.branches.map(br => {
      const color = this.graph.branchColors[br.name] || '#6e7681';
      return `<span class="legend-branch-chip"
        style="background:${color}18;border-color:${color};color:${color}"
      >${br.name}</span>`;
    }).join('');
    this.el.legendTags.innerHTML = chips;
  }

  /* ── State Machine ───────────────────────────────────── */

  _setState(state) {
    this.state = state;

    const isLoading = state === 'loading' || state === 'processing';
    this.el.loadingOverlay.classList.toggle('hidden', !isLoading);
    this.el.errorOverlay.classList.toggle('hidden',   state !== 'error');
    this.el.emptyState.style.display = state === 'idle' ? '' : 'none';
    this.el.loadBtn.disabled          = isLoading;

    if (state === 'idle') {
      this._hideCommitDetails();
      this.el.repoLabel.textContent   = '';
      this.el.commitCount.textContent = '';
      this.el.legendTags.innerHTML    = '';
      this.el.rateLimit.textContent   = '';
    }
  }

  _setLoadingMsg(msg) {
    this.el.loadingMsg.textContent = msg;
  }

  _showError(msg) {
    this.el.errorMsg.textContent = msg;
    this._setState('error');
  }

  /* ── Rate Limit ──────────────────────────────────────── */

  _updateRateLimit() {
    const n = this.api.rateLimitRemaining;
    this.el.rateLimit.textContent = `API: ${n}/60`;
    // Visual warning when low
    this.el.rateLimit.style.color = n <= 10 ? '#ffa657' : n <= 5 ? '#ff7b72' : '';
  }

  /* ── Utility ─────────────────────────────────────────── */

  _tick() {
    return new Promise(r => requestAnimationFrame(r));
  }
}

/* Bootstrap */
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
