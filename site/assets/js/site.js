(() => {
  const repo = 'edmen12/deskmcp';
  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  const releaseVersion = document.getElementById('release-version');
  const releaseStatus = document.getElementById('release-status');
  const x64Link = document.getElementById('download-x64');
  const arm64Link = document.getElementById('download-arm64');
  const x64Size = document.getElementById('size-x64');
  const arm64Size = document.getElementById('size-arm64');

  const formatSize = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  async function loadLatestRelease() {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status}`);

      const release = await response.json();
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const x64 = assets.find(asset => /^DeskMCP-Setup-.*\.exe$/i.test(asset.name) && !/arm64/i.test(asset.name));
      const arm64 = assets.find(asset => /^DeskMCP-Setup-.*arm64.*\.exe$/i.test(asset.name));

      if (releaseVersion && release.tag_name) releaseVersion.textContent = release.tag_name;
      if (releaseStatus) releaseStatus.textContent = 'Published on GitHub';

      if (x64 && x64Link) {
        x64Link.href = x64.browser_download_url;
        if (x64Size) x64Size.textContent = `${formatSize(x64.size)} · Standard Windows PCs`;
      }
      if (arm64 && arm64Link) {
        arm64Link.href = arm64.browser_download_url;
        if (arm64Size) arm64Size.textContent = `${formatSize(arm64.size)} · Native ARM64 build`;
      }
    } catch (error) {
      if (releaseStatus) releaseStatus.textContent = 'Open GitHub for latest files';
      console.warn('DeskMCP release metadata unavailable:', error);
    }
  }

  function updateScrollState() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const progress = Math.min(1, Math.max(0, scrollTop / maxScroll));
    root.style.setProperty('--scroll-progress', `${(progress * 100).toFixed(2)}%`);
    document.querySelector('.topbar')?.classList.toggle('is-scrolled', scrollTop > 24);
  }

  function setupReveals() {
    if (reducedMotion || !('IntersectionObserver' in window)) return;

    root.classList.add('motion-ready');
    const groups = [
      '.signal-strip > div',
      '.section-index',
      '.manifesto-heading',
      '.manifesto-lead',
      '.principles article',
      '.permission-intro > *',
      '.permission-row',
      '.product-story-copy > *',
      '.product-story-visual',
      '.security-heading',
      '.architecture-wrap',
      '.security-list article',
      '.start-heading > *',
      '.steps li',
      '.download-topline > *',
      '.download-row',
      '.final-cta > *'
    ];

    const elements = [...new Set(groups.flatMap(selector => [...document.querySelectorAll(selector)]))];
    elements.forEach((element, index) => {
      element.classList.add('reveal');
      element.style.setProperty('--reveal-order', String(index % 4));
    });

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    elements.forEach(element => observer.observe(element));
  }

  function setupActiveNavigation() {
    if (!('IntersectionObserver' in window)) return;
    const navLinks = [...document.querySelectorAll('.nav a[href^="#"]')];
    const targets = navLinks
      .map(link => ({ link, target: document.querySelector(link.getAttribute('href')) }))
      .filter(item => item.target);
    if (!targets.length) return;

    const observer = new IntersectionObserver(entries => {
      const visible = entries
        .filter(entry => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      navLinks.forEach(link => link.classList.remove('is-active'));
      targets.find(item => item.target === visible.target)?.link.classList.add('is-active');
    }, { threshold: [0.18, 0.35, 0.55], rootMargin: '-24% 0px -55% 0px' });

    targets.forEach(item => observer.observe(item.target));
  }

  function setupHeroParallax() {
    if (reducedMotion || !finePointer) return;
    const hero = document.querySelector('.hero-product');
    if (!hero) return;

    hero.addEventListener('pointermove', event => {
      const rect = hero.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) - 0.5;
      const y = ((event.clientY - rect.top) / rect.height) - 0.5;
      hero.style.setProperty('--hero-panel-x', `${(x * 10).toFixed(2)}px`);
      hero.style.setProperty('--hero-panel-y', `${(y * 8).toFixed(2)}px`);
      hero.style.setProperty('--hero-grid-x', `${(x * -3).toFixed(2)}px`);
      hero.style.setProperty('--hero-grid-y', `${(y * -2).toFixed(2)}px`);
      hero.style.setProperty('--hero-glow-x', `${(x * 4).toFixed(2)}px`);
      hero.style.setProperty('--hero-glow-y', `${(y * 3).toFixed(2)}px`);
      hero.style.setProperty('--hero-float-left-x', `${(x * -5).toFixed(2)}px`);
      hero.style.setProperty('--hero-float-left-y', `${(y * -4).toFixed(2)}px`);
      hero.style.setProperty('--hero-float-right-x', `${(x * 5).toFixed(2)}px`);
      hero.style.setProperty('--hero-float-right-y', `${(y * 4).toFixed(2)}px`);
    }, { passive: true });

    hero.addEventListener('pointerleave', () => {
      ['--hero-panel-x','--hero-panel-y','--hero-grid-x','--hero-grid-y','--hero-glow-x','--hero-glow-y','--hero-float-left-x','--hero-float-left-y','--hero-float-right-x','--hero-float-right-y']
        .forEach(property => hero.style.setProperty(property, '0px'));
    });
  }

  loadLatestRelease();
  setupReveals();
  setupActiveNavigation();
  setupHeroParallax();
  updateScrollState();

  window.addEventListener('scroll', updateScrollState, { passive: true });
  window.addEventListener('resize', updateScrollState, { passive: true });

  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('site-ready')));
})();