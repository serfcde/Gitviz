/**
 * GitHubAPIClient
 * Handles all communication with the GitHub REST API.
 * - URL validation & parsing
 * - Paginated commit & branch fetching
 * - Individual commit detail (file diff) fetching
 * - Rate-limit tracking and graceful error handling
 */
class GitHubAPIClient {
  constructor() {
    this.baseUrl = 'https://api.github.com';
    this._cache = new Map();
    this.rateLimitRemaining = 60;
    this.rateLimitReset = null;
  }

  /* ── URL Validation ──────────────────────────────────── */

  validateUrl(url) {
    const trimmed = (url || '').trim().replace(/\/$/, '');
    return /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(trimmed);
  }

  parseUrl(url) {
    const trimmed = (url || '').trim().replace(/\/$/, '');
    const m = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/);
    if (!m) throw new Error('Invalid GitHub repository URL format.');
    return { owner: m[1], repo: m[2] };
  }

  /* ── Core HTTP ───────────────────────────────────────── */

  async _get(endpoint) {
    const url = `${this.baseUrl}${endpoint}`;

    if (this._cache.has(url)) return this._cache.get(url);

    let response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/vnd.github.v3+json' }
      });
    } catch (err) {
      throw new Error('Network unavailable. Please check your internet connection.');
    }

    // Track rate limit
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const reset = response.headers.get('X-RateLimit-Reset');
    if (remaining !== null) this.rateLimitRemaining = parseInt(remaining, 10);
    if (reset !== null) this.rateLimitReset = new Date(parseInt(reset, 10) * 1000);

    if (!response.ok) {
      if (response.status === 404)
        throw new Error('Repository not found (404). Check the URL and ensure the repository is public.');
      if (response.status === 403)
        throw new Error('GitHub API rate limit exceeded (403). You have 60 unauthenticated requests/hour. Please wait or add a token.');
      if (response.status === 500)
        throw new Error('GitHub server error (500). Please try again later.');
      throw new Error(`GitHub API error: HTTP ${response.status}`);
    }

    const data = await response.json();
    this._cache.set(url, data);
    return data;
  }

  /* ── Public API Methods ──────────────────────────────── */

  async fetchRepo(owner, repo) {
    return this._get(`/repos/${owner}/${repo}`);
  }

  async fetchBranches(owner, repo) {
    const results = [];
    let page = 1;
    while (true) {
      const data = await this._get(
        `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`
      );
      results.push(...data);
      if (data.length < 100 || page >= 5) break; // cap at 500 branches
      page++;
    }
    return results;
  }

  /**
   * Fetch commits up to `maxCommits` (default 300).
   * The API returns commits newest-first, which is what we want.
   */
  async fetchCommits(owner, repo, maxCommits = 300) {
    const all = [];
    let page = 1;
    const perPage = 100;

    while (all.length < maxCommits) {
      const data = await this._get(
        `/repos/${owner}/${repo}/commits?per_page=${perPage}&page=${page}`
      );
      all.push(...data);
      if (data.length < perPage) break;
      page++;
      if (all.length >= maxCommits) break;
    }

    return all.slice(0, maxCommits);
  }

  /**
   * Fetch detailed info for one commit (includes file diffs).
   */
  async fetchCommitDetail(owner, repo, sha) {
    return this._get(`/repos/${owner}/${repo}/commits/${sha}`);
  }

  /* ── Cache Control ───────────────────────────────────── */

  clearCache() {
    this._cache.clear();
  }

  get rateLimitSummary() {
    const reset = this.rateLimitReset
      ? this.rateLimitReset.toLocaleTimeString()
      : '—';
    return `${this.rateLimitRemaining}/60 (resets ${reset})`;
  }
}
