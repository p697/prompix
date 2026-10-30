// Progressive enhancement only: every page works without this script.
(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Close the language menu when clicking elsewhere or pressing Escape.
  const menu = document.querySelector('.lang');
  if (menu) {
    document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') menu.open = false; });
  }

  // Horizontal rail: previous/next buttons page by the visible width.
  for (const rail of document.querySelectorAll('[data-rail]')) {
    const controls = rail.nextElementSibling;
    const previous = controls?.querySelector('[data-rail-prev]');
    const next = controls?.querySelector('[data-rail-next]');
    const update = () => {
      const max = rail.scrollWidth - rail.clientWidth - 2;
      if (previous) previous.disabled = rail.scrollLeft <= 2;
      if (next) next.disabled = rail.scrollLeft >= max;
    };
    const step = direction => {
      const tile = rail.querySelector('li');
      const width = tile ? tile.getBoundingClientRect().width + 20 : rail.clientWidth * 0.8;
      const count = Math.max(1, Math.floor(rail.clientWidth / width) - 1);
      rail.scrollBy({ left: direction * width * count, behavior: reduceMotion ? 'auto' : 'smooth' });
    };
    previous?.addEventListener('click', () => step(-1));
    next?.addEventListener('click', () => step(1));
    rail.addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    update();
  }

  // Copy the prompt that is currently shown.
  for (const button of document.querySelectorAll('[data-copy]')) {
    const status = button.parentElement.querySelector('.copy-status');
    const label = button.textContent;
    button.addEventListener('click', async () => {
      const visible = document.querySelector('.prompt-text:not([hidden])') ?? document.getElementById(button.dataset.copy);
      try {
        await navigator.clipboard.writeText(visible.textContent);
        button.textContent = button.dataset.copied;
        setTimeout(() => { button.textContent = label; }, 1800);
        if (status) status.textContent = '';
      } catch {
        if (status) status.textContent = button.dataset.failed;
        const range = document.createRange();
        range.selectNodeContents(visible);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    });
  }

  // Translation / original toggle.
  for (const group of document.querySelectorAll('.toggle')) {
    const buttons = [...group.querySelectorAll('button')];
    for (const button of buttons) button.addEventListener('click', () => {
      for (const other of buttons) {
        const active = other === button;
        other.setAttribute('aria-pressed', String(active));
        document.getElementById(other.dataset.show).hidden = !active;
      }
    });
  }

  // Long prompts start clamped with a "show all" control.
  for (const body of document.querySelectorAll('[data-clamp]')) {
    const expand = body.querySelector('[data-expand]');
    const text = body.querySelector('.prompt-text:not([hidden])');
    if (!expand || !text || text.scrollHeight < 520) continue;
    body.classList.add('clamped');
    expand.hidden = false;
    expand.addEventListener('click', () => { body.classList.remove('clamped'); expand.remove(); });
  }

  // "Show more" appends the next page in place and keeps the link as a no-script fallback.
  for (const more of document.querySelectorAll('[data-more]')) {
    const grid = document.querySelector('[data-grid]');
    if (!grid) continue;
    more.addEventListener('click', async event => {
      event.preventDefault();
      if (more.getAttribute('aria-busy') === 'true') return;
      more.setAttribute('aria-busy', 'true');
      try {
        const response = await fetch(more.href, { headers: { Accept: 'text/html' } });
        if (!response.ok) throw new Error(String(response.status));
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const items = page.querySelectorAll('[data-grid] > li');
        for (const item of items) grid.append(document.importNode(item, true));
        const next = page.querySelector('[data-more]');
        if (next) { more.href = next.href; more.removeAttribute('aria-busy'); }
        else more.parentElement.remove();
        history.replaceState(null, '', location.href);
      } catch {
        location.href = more.href;
      }
    });
  }

  // Videos in tiles play muted while visible.
  const videos = document.querySelectorAll('video[data-autoplay]');
  if (videos.length && !reduceMotion && 'IntersectionObserver' in window) {
    const watcher = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) entry.target.play().catch(() => {});
        else entry.target.pause();
      }
    }, { threshold: 0.35 });
    for (const video of videos) watcher.observe(video);
  }

  // Gentle reveal as sections enter the viewport.
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const targets = document.querySelectorAll('.section .headline, .section-lead, .section-head .link, .bento-tile, .stat-hero, .stat-label, .stat-row, .creators li, .languages, .app-icon, .iphone .pill');
    const revealer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        revealer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    for (const target of targets) {
      if (target.getBoundingClientRect().top < innerHeight) continue;
      target.classList.add('reveal');
      revealer.observe(target);
    }
  }
})();
