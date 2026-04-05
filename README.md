# GitViz — Repository Visualizer

A reverse-engineered, simplified clone of GitKraken built as a web application.
Visualizes GitHub repository commit history as an interactive DAG (Directed Acyclic Graph).

---

## Features

| Feature | Description |
|---|---|
| **Repository Loading** | Enter any public GitHub URL → validates format, fetches metadata |
| **Commit Graph (DAG)** | Commits rendered as nodes, parent→child as directed edges |
| **Branch Visualization** | Each branch gets a unique color lane; labels shown at branch heads |
| **Merge Commit Highlighting** | Merge commits shown with double ring and dashed incoming edges |
| **Interactive Exploration** | Zoom (scroll), Pan (drag), Select commit (click) |
| **Commit Details Panel** | Hash, message, author, date, branch, parent SHAs |
| **File Evolution Tracking** | Added / modified / deleted files with +/- line counts per commit |
| **Error Handling** | Graceful messages for 404, 403 rate-limit, 500, offline, private repos |

---

## Quick Start

1. **Open `index.html`** in any modern browser (Chrome, Firefox, Edge, Safari).
   - No build step, no server required.
   - Requires an active internet connection (GitHub API + Google Fonts CDN).

2. **Enter a public GitHub URL** in the header input:
   ```
   https://github.com/octocat/Hello-World
   https://github.com/git/git
   https://github.com/torvalds/linux
   ```

3. Click **Load Repository** or press `Enter`.

4. **Interact with the graph:**
   - 🖱 **Scroll** to zoom in/out
   - 🖱 **Drag** to pan
   - 🖱 **Click a node** to see commit details + file changes
   - ⌨ `Ctrl+K` / `Cmd+K` to focus the URL bar

---

## Architecture

```
gitviz/
├── index.html          Main HTML structure
├── css/
│   └── app.css         Dark theme (GitKraken-inspired)
├── js/
│   ├── api.js          GitHub REST API client (validation, fetching, caching)
│   ├── graph.js        DAG: CommitNode + CommitGraph (lane assignment, edge data)
│   ├── visualizer.js   D3.js SVG renderer (zoom/pan, node/edge/label drawing)
│   └── app.js          App controller (state machine, event binding, DOM updates)
└── README.md
```

### Module Responsibilities

**`api.js` — GitHubAPIClient**
- URL validation via regex
- Paginated commit + branch fetching (up to 300 commits, 500 branches)
- Individual commit diff fetching for file evolution tracking
- In-memory response cache (per session)
- Rate-limit header parsing and exposure

**`graph.js` — CommitGraph**
- Builds adjacency-list DAG from raw API data
- Topological sort (newest → oldest by timestamp)
- **Lane assignment** — mirrors `git log --graph` algorithm:
  - Active lane tracking (one slot per in-progress branch line)
  - First parent continues in same lane
  - Additional parents (merge sources) open new lanes
- Branch label propagation (DFS from each branch head)
- Color palette assignment (main/master always gets green)

**`visualizer.js` — GraphVisualizer**
- D3 zoom & pan on the root `<g>` element
- Straight edges for same-lane parent-child
- Cubic bezier curves for cross-lane edges
- Merge commit outer ring + dashed edges
- Branch name label tags rendered beside each branch head
- Node selection with highlight ring

**`app.js` — App**
- State machine: `idle → loading → processing → visualized → error`
- Coordinates API + Graph + Visualizer
- Renders commit details panel including async file change loading
- Branch legend in footer
- Rate-limit badge in header

---

## Constraints & Limitations

| Constraint | Detail |
|---|---|
| Public repos only | GitHub unauthenticated API only supports public repositories |
| Rate limit | 60 requests/hour without a token |
| Commit cap | Up to 300 commits fetched (configurable in `api.js`) |
| No write operations | View-only; no commit/push/pull functionality |
| No local Git | Reads from GitHub API, not a local `.git` directory |

---

## Aligning with SRS Requirements

| SRS Requirement | Implemented |
|---|---|
| Valid GitHub URL input | ✅ Regex + error feedback |
| GitHub REST API retrieval | ✅ Commits, branches, file diffs |
| DAG graph model | ✅ CommitGraph with adjacency list |
| Commit nodes + edges | ✅ Circle nodes, bezier/straight edges |
| Branch color differentiation | ✅ 12-color palette, lane-based layout |
| Merge commit highlighting | ✅ Double ring, dashed edges |
| Zoom & pan | ✅ D3 zoom behaviour |
| Commit detail on click | ✅ Details panel |
| File-level changes | ✅ API `/commits/{sha}` + diff display |
| Error handling (404/403/500/offline) | ✅ Typed error messages |
| Modular architecture | ✅ api / graph / visualizer / app |
| Browser-based, no install | ✅ Single `index.html` + CDN |

---

## Browser Requirements

- Chrome 90+, Firefox 88+, Edge 90+, Safari 14+
- JavaScript ES2020 (`class`, `async/await`, optional chaining)
- D3 v7 (loaded from cdnjs.cloudflare.com)
