/**
 * GraphVisualizer
 * Renders the commit DAG using D3.js inside an SVG element.
 * Supports: zoom/pan, node selection, commit hover, branch labels.
 */
class GraphVisualizer {
  constructor(svgEl, onSelect) {
    this.svgEl    = svgEl;
    this.onSelect = onSelect || (() => {});
    this.svg      = d3.select(svgEl);
    this.g        = null;
    this.zoomBeh  = null;
    this.graph    = null;
    this.selectedSha = null;
  }

  /* ── Render ──────────────────────────────────────────── */

  render(graph) {
    this.graph = graph;
    this.svg.selectAll('*').remove();

    const container = this.svgEl.parentElement;
    const W = container.clientWidth;
    const H = container.clientHeight;

    this.svg.attr('width', W).attr('height', H);

    // Root group (receives zoom transform)
    this.g = this.svg.append('g').attr('class', 'graph-root');

    // Zoom behaviour
    this.zoomBeh = d3.zoom()
      .scaleExtent([0.05, 5])
      .on('zoom', e => this.g.attr('transform', e.transform));
    this.svg.call(this.zoomBeh);

    // Click on blank SVG = deselect
    this.svg.on('click', e => {
      if (e.target === this.svgEl) this._deselect();
    });

    // Draw layers (order matters: edges below nodes, labels on top)
    this._drawEdges(graph.getEdges());
    this._drawNodes(graph.commits, graph.labelStartX);
    this._drawBranchLabels(graph);

    // Initial fit
    this._fitView(W, H);
  }

  /* ── Edges ───────────────────────────────────────────── */

  _drawEdges(edges) {
    const layer = this.g.append('g').attr('class', 'layer-edges');
    const { LANE_W, ROW_H } = CommitGraph;

    for (const { fromNode: f, toNode: t, color, isMerge } of edges) {
      const d = this._edgePath(f, t);
      layer.append('path')
        .attr('class', 'edge-path')
        .attr('d', d)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', isMerge ? 1.5 : 1.8)
        .attr('stroke-dasharray', isMerge ? '4,2' : null)
        .attr('opacity', 0.65);
    }
  }

  _edgePath(f, t) {
    const x1 = f.x, y1 = f.y;
    const x2 = t.x, y2 = t.y;

    if (Math.abs(x1 - x2) < 0.5) {
      // Same lane → straight line
      return `M${x1},${y1} L${x2},${y2}`;
    }

    // Different lane → smooth cubic bezier
    const rowDiff = t.row - f.row;
    const bendY = Math.min(rowDiff * CommitGraph.ROW_H * 0.4,
                            CommitGraph.ROW_H * 1.5);
    return `M${x1},${y1} C${x1},${y1 + bendY} ${x2},${y2 - bendY} ${x2},${y2}`;
  }

  /* ── Nodes ───────────────────────────────────────────── */

  _drawNodes(commits, labelX) {
    const layer = this.g.append('g').attr('class', 'layer-nodes');
    const R = CommitGraph.NODE_R;
    const H = CommitGraph.ROW_H;

    for (const node of commits) {
      const gNode = layer.append('g')
        .attr('class', 'commit-node')
        .attr('transform', `translate(0, ${node.y})`)
        .datum(node)
        .style('cursor', 'pointer')
        .on('click', (e, d) => {
          e.stopPropagation();
          this._selectNode(d);
        });

      // Full-width row hover background
      gNode.append('rect')
        .attr('class', 'commit-row-bg')
        .attr('x', 0)
        .attr('y', -H / 2)
        .attr('width', labelX + 600)
        .attr('height', H)
        .attr('fill', 'transparent');

      // Merge outer ring
      if (node.isMerge) {
        gNode.append('circle')
          .attr('cx', node.x)
          .attr('cy', 0)
          .attr('r', R + 3.5)
          .attr('fill', 'none')
          .attr('stroke', node.branchColor)
          .attr('stroke-width', 1.5)
          .attr('opacity', 0.45);
      }

      // Main circle
      gNode.append('circle')
        .attr('class', 'node-circle')
        .attr('cx', node.x)
        .attr('cy', 0)
        .attr('r', R)
        .attr('fill', node.branchColor)
        .attr('stroke', '#0d1117')
        .attr('stroke-width', 1.5);

      // Root commit diamond overlay
      if (node.isRoot) {
        const s = R - 1;
        gNode.append('polygon')
          .attr('points', `${node.x},${-s} ${node.x + s},0 ${node.x},${s} ${node.x - s},0`)
          .attr('fill', '#0d1117')
          .attr('opacity', 0.5)
          .style('pointer-events', 'none');
      }

      // ── Text labels to the right ──────────────────────
      const lx = labelX;

      // Commit message
      gNode.append('text')
        .attr('class', 'commit-label')
        .attr('x', lx)
        .attr('y', -3)
        .text(this._trunc(node.message, 62));

      // Row 2: sha · author · date
      gNode.append('text')
        .attr('class', 'commit-sha-label')
        .attr('x', lx)
        .attr('y', 10)
        .text(node.shortSha);

      gNode.append('text')
        .attr('class', 'commit-author-label')
        .attr('x', lx + 52)
        .attr('y', 10)
        .text(this._trunc(node.author, 22));

      gNode.append('text')
        .attr('class', 'commit-date-label')
        .attr('x', lx + 200)
        .attr('y', 10)
        .text(node.formattedDate);
    }
  }

  /* ── Branch Labels ───────────────────────────────────── */

  _drawBranchLabels(graph) {
    const layer = this.g.append('g').attr('class', 'layer-branch-labels');
    const PADDING = 5;
    const HEIGHT  = 14;
    const lx      = graph.labelStartX;

    // Group branches by sha so multiple labels stack nicely
    const byHead = new Map();
    for (const br of graph.branches) {
      const node = graph.commitMap.get(br.commit.sha);
      if (!node) continue;
      if (!byHead.has(br.commit.sha)) byHead.set(br.commit.sha, []);
      byHead.get(br.commit.sha).push(br);
    }

    const CHAR_W = 6.2;

    for (const [sha, brs] of byHead) {
      const node = graph.commitMap.get(sha);
      if (!node) continue;

      // Estimate starting X (after message text)
      const msgLen = Math.min(node.message.length, 62);
      let cx = lx + msgLen * CHAR_W + 14;

      for (const br of brs) {
        const color = graph.branchColors[br.name] || '#888';
        const labelW = br.name.length * CHAR_W + PADDING * 2 + 2;

        const gLbl = layer.append('g')
          .attr('class', 'branch-label-group')
          .attr('transform', `translate(${cx}, ${node.y - HEIGHT / 2})`);

        gLbl.append('rect')
          .attr('class', 'branch-label-rect')
          .attr('width', labelW)
          .attr('height', HEIGHT)
          .attr('rx', 3)
          .attr('fill', color);

        gLbl.append('text')
          .attr('class', 'branch-label-text')
          .attr('x', PADDING)
          .attr('y', 10)
          .text(br.name);

        cx += labelW + 4;
      }
    }
  }

  /* ── Selection ───────────────────────────────────────── */

  _selectNode(node) {
    this._deselect(false);
    this.selectedSha = node.sha;

    // Highlight in graph
    this.g.selectAll('.commit-node')
      .filter(d => d.sha === node.sha)
      .classed('selected', true)
      .select('.node-circle')
        .attr('stroke', '#ffffff')
        .attr('stroke-width', 2.5);

    this.onSelect(node);
  }

  _deselect(notify = true) {
    this.selectedSha = null;
    if (!this.g) return;

    this.g.selectAll('.commit-node')
      .classed('selected', false)
      .select('.node-circle')
        .attr('stroke', '#0d1117')
        .attr('stroke-width', 1.5);

    if (notify) this.onSelect(null);
  }

  /* ── Zoom Controls ───────────────────────────────────── */

  zoomIn()    { this.svg.transition().duration(220).call(this.zoomBeh.scaleBy, 1.35); }
  zoomOut()   { this.svg.transition().duration(220).call(this.zoomBeh.scaleBy, 0.74); }
  resetView() {
    const W = this.svgEl.parentElement.clientWidth;
    const H = this.svgEl.parentElement.clientHeight;
    this._fitView(W, H, 400);
  }

  _fitView(W, H, duration = 0) {
    if (!this.graph || !this.graph.commits.length) return;

    const gW = this.graph.totalWidth;
    const gH = this.graph.totalHeight;

    // Scale to fit, but cap at 1.2
    const scale = Math.min(W / gW, H / gH, 1.2);
    const tx = Math.max((W - gW * scale) / 2, 10);
    const ty = 12;

    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
    if (duration > 0) {
      this.svg.transition().duration(duration).call(this.zoomBeh.transform, t);
    } else {
      this.svg.call(this.zoomBeh.transform, t);
    }
  }

  /* ── Utility ─────────────────────────────────────────── */

  _trunc(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  }
}
