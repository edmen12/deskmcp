(() => {
  const repo = 'edmen12/deskmcp';
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

  loadLatestRelease();
})();
