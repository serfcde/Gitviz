/**
 * App — main controller.
 * Orchestrates API client, graph builder, and visualizer.
 * Manages the state machine: idle → loading → processing → visualized → error.
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
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.el.urlInput.focus();
        this.el.urlInput.select();
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

    if (!rawUrl) {
      this._showError('Please enter a repository URL (e.g. https://github.com/owner/repo).');
      return;
    }

    if (!this.api.validateUrl(rawUrl)) {
      this._showError(
        'Invalid GitHub URL format. Expected: https://github.com/owner/repository\n' +
        'Make sure there is no trailing path (no /tree/main etc.).'
      );
      return;
    }

    let owner, repo;
    try { ({ owner, repo } = this.api.parseUrl(rawUrl)); }
    catch (e) { this._showError(e.message); return; }

    this._setState('loading');
    this._setLoadingMsg('Connecting to GitHub API…');
    this.api.clearCache();

    try {
      /* 1 — Repo metadata */
      this._setLoadingMsg('Fetching repository metadata…');
      const repoData = await this.api.fetchRepo(owner, repo);

      if (repoData.private) {
        throw new Error(
          'This repository is private. GitViz only supports public repositories.'
        );
      }

      this.currentRepo = { owner, repo };
      this.el.repoLabel.textContent = `${owner} / ${repo}`;

      /* 2 — Branches */
      this._setLoadingMsg('Fetching branches…');
      const branchesRaw = await this.api.fetchBranches(owner, repo);

      /* 3 — Commits */
      this._setLoadingMsg('Fetching commit history (up to 300)…');
      const commitsRaw = await this.api.fetchCommits(owner, repo, 300);

      if (!commitsRaw.length) {
        throw new Error('No commits found in this repository.');
      }

      /* 4 — Build DAG */
      this._setLoadingMsg('Building commit graph…');
      this.graph.build(commitsRaw, branchesRaw);

      /* 5 — Render */
      this._setLoadingMsg('Rendering visualization…');
      // Let the DOM breathe before heavy D3 work
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

    // File changes
    this.el.cdFileStats.innerHTML     = '';
    this.el.cdFileLoading.style.display = 'block';
    this.el.cdFileLoading.textContent = 'Loading file changes…';
    this.el.cdFileList.innerHTML      = '';

    this._loadFileChanges(node.sha);
    this._updateRateLimit();
  }

  _hideCommitDetails() {
    this.el.detailsIdle.style.display   = 'block';
    this.el.commitDetails.classList.add('hidden');
  }

  async _loadFileChanges(sha) {
    if (!this.currentRepo) return;
    const { owner, repo } = this.currentRepo;

    try {
      const detail = await this.api.fetchCommitDetail(owner, repo, sha);
      const files  = detail.files || [];

      this.el.cdFileLoading.style.display = 'none';

      if (!files.length) {
        this.el.cdFileList.innerHTML =
          '<p class="no-file-changes">No file changes for this commit.</p>';
        return;
      }

      // Stats
      const add  = files.reduce((s, f) => s + (f.additions || 0), 0);
      const del  = files.reduce((s, f) => s + (f.deletions  || 0), 0);
      this.el.cdFileStats.innerHTML =
        `<span class="stat-chip stat-add">+${add}</span>` +
        `<span class="stat-chip stat-del">−${del}</span>`;

      // File list HTML
      const html = files.map(f => {
        const typeMap  = { added:'A', removed:'D', modified:'M', renamed:'R', copied:'C' };
        const classMap = {
          added:'file-added', removed:'file-deleted', modified:'file-modified',
          renamed:'file-renamed', copied:'file-renamed'
        };
        const badge = typeMap[f.status]  || 'M';
        const cls   = classMap[f.status] || 'file-modified';
        const name  = f.filename;
        const addTxt = f.additions ? `<span class="file-add">+${f.additions}</span>` : '';
        const delTxt = f.deletions ? `<span class="file-del">−${f.deletions}</span>`  : '';

        return `<div class="file-item ${cls}">
          <span class="file-type-badge">${badge}</span>
          <span class="file-path" title="${name}">${name}</span>
          <span class="file-diff">${addTxt}${delTxt}</span>
        </div>`;
      }).join('');

      this.el.cdFileList.innerHTML = html;
      this._updateRateLimit();

    } catch (err) {
      this.el.cdFileLoading.textContent = `Could not load file changes: ${err.message}`;
    }
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
    this.el.emptyState.style.display = state === 'idle'       ? '' : 'none';
    this.el.loadBtn.disabled          = isLoading;

    if (state === 'idle') {
      this._hideCommitDetails();
      this.el.repoLabel.textContent  = '';
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
    this.el.rateLimit.textContent = `API: ${this.api.rateLimitRemaining}/60`;
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
