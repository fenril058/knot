const script = document.currentScript;
const project = script.dataset.project;
let titles = null;
let debounceTimer = null;

async function loadTitles() {
  if (titles !== null) return titles;
  const res = await fetch(`/api/pages/${encodeURIComponent(project)}/search/titles`);
  titles = await res.json();
  return titles;
}

function pageHref(title) {
  return `/${encodeURIComponent(project)}/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

function renderHits(el, items, formatLabel) {
  el.replaceChildren();
  if (items.length === 0) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  for (const item of items) {
    const a = document.createElement('a');
    a.href = pageHref(item.title);
    a.className = 'search-hit';
    a.textContent = formatLabel(item);
    el.appendChild(a);
  }
}

document.getElementById('search-box').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  const resultsEl = document.getElementById('search-results');
  clearTimeout(debounceTimer);
  if (q === '') {
    renderHits(resultsEl, [], () => '');
    return;
  }
  const all = await loadTitles();
  const lc = q.toLowerCase();
  renderHits(resultsEl, all.filter((t) => t.title.toLowerCase().includes(lc)).slice(0, 20), (t) => t.title);

  debounceTimer = setTimeout(async () => {
    const res = await fetch(`/api/pages/${encodeURIComponent(project)}/search/query?q=${encodeURIComponent(q)}`);
    const body = await res.json();
    renderHits(resultsEl, body.pages, (p) => `${p.title}: ${p.lines[0] ?? ''}`);
  }, 200);
});
