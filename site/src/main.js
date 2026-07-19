import "merak-protocol-design-system/style.css";
import "./site.css";

const GH = "https://github.com/snowmerak/komika";
const RELEASE_V021 = `${GH}/releases/tag/v0.2.1`;
const RELEASE_V010 = `${GH}/releases/tag/v0.1.0`;
const RELEASES = `${GH}/releases`;
const DOCS_V021 = `${GH}/blob/main/docs/releases/v0.2.1.md`;

document.querySelector("#app").innerHTML = `
<a class="site-skip" href="#main">Skip to content</a>

<header class="site-nav">
  <a class="site-nav__brand" href="#top" aria-label="Komika home">
    <img class="site-nav__mark" src="./komika-mark.png" width="36" height="36" alt="" />
    <span class="site-nav__name">Komika</span>
  </a>
  <nav class="site-nav__links" aria-label="Primary">
    <a href="#features">Features</a>
    <a href="#formats">Formats</a>
    <a href="#release">Release</a>
    <a href="#get">Get</a>
  </nav>
  <div class="site-nav__actions mp-button-row">
    <a class="mp-button mp-button--ghost mp-button--sm" href="${GH}">GitHub</a>
    <a class="mp-button mp-button--primary mp-button--sm" href="${RELEASES}">Download</a>
  </div>
</header>

<main id="main">
  <section class="site-hero" id="top" aria-labelledby="hero-title">
    <div class="site-hero__copy">
      <p class="mp-eyebrow">Local-first · Wails v3 · Go + TypeScript</p>
      <h1 id="hero-title">Read comics, media, and documents without the cloud.</h1>
      <p class="site-hero__lead mp-text--secondary">
        Komika is a cross-platform reader for archives, folders, video, audio, PDF, and Markdown —
        with BandiView-style view modes, high-quality upscaling, and playback that recovers when the
        host WebView cannot decode a clip.
      </p>
      <div class="mp-badge-row site-hero__badges">
        <span class="mp-badge mp-badge--sm mp-badge--type">v0.2.1</span>
        <span class="mp-badge mp-badge--sm mp-badge--sealed">Windows · Linux · macOS</span>
        <span class="mp-badge mp-badge--sm mp-badge--partial">amd64 · arm64</span>
      </div>
      <div class="mp-button-row">
        <a class="mp-button mp-button--primary" href="${RELEASE_V021}">Get v0.2.1</a>
        <a class="mp-button mp-button--secondary" href="${GH}">View source</a>
        <a class="mp-button mp-button--ghost" href="#features">Explore features</a>
      </div>
    </div>
    <div class="site-hero__brand" aria-hidden="true">
      <div class="site-hero__glow"></div>
      <img
        class="site-hero__logo"
        src="./komika-logo.webp"
        width="560"
        height="560"
        alt=""
        decoding="async"
      />
    </div>
  </section>

  <section class="site-section" id="features" aria-labelledby="features-title">
    <div class="mp-section-heading">
      <p class="mp-eyebrow">Product</p>
      <h2 id="features-title">Built for long reading sessions</h2>
      <p class="mp-text--secondary">
        View modes, scaling filters, and a local library that remembers where you left off.
      </p>
    </div>
    <div class="mp-grid">
      <article class="mp-card">
        <div class="mp-card__header">
          <div>
            <p class="mp-card__eyebrow">View modes</p>
            <h3 class="mp-card__title">Comic-first layout</h3>
          </div>
        </div>
        <p class="mp-card__body mp-text--secondary">
          Fit window, width, height, original 100%, double-page LTR/RTL, continuous webtoon strip,
          stretch small images, and manual zoom 25–800% with pan.
        </p>
      </article>
      <article class="mp-card">
        <div class="mp-card__header">
          <div>
            <p class="mp-card__eyebrow">Scaling</p>
            <h3 class="mp-card__title">Settled-tile HQ filters</h3>
          </div>
        </div>
        <p class="mp-card__body mp-text--secondary">
          Smooth, Lanczos-3, NoHalo, pure TypeScript xBRZ (2–6×), and pixelated. HQ runs on settled
          viewport tiles; animated GIFs stay live and skip canvas filters.
        </p>
      </article>
      <article class="mp-card">
        <div class="mp-card__header">
          <div>
            <p class="mp-card__eyebrow">Library</p>
            <h3 class="mp-card__title">Resume locally</h3>
          </div>
        </div>
        <p class="mp-card__body mp-text--secondary">
          Up to 20 recent works with per-work progress, retention windows, and storage under
          <code class="site-code">\${os.UserConfigDir()}/komika/library.json</code>.
        </p>
      </article>
      <article class="mp-card mp-card--trace">
        <div class="mp-card__header">
          <div>
            <p class="mp-card__eyebrow">Playback</p>
            <h3 class="mp-card__title">Beyond host codecs</h3>
          </div>
        </div>
        <p class="mp-card__body mp-text--secondary">
          Host ffmpeg and ffmpeg.wasm fallbacks, WebKitGTK Range streams, MP4 faststart remux,
          stall recovery, soft-loop, and in-reader diagnostics when something still fails.
        </p>
      </article>
      <article class="mp-card mp-card--gate">
        <div class="mp-card__header">
          <div>
            <p class="mp-card__eyebrow">Desktop</p>
            <h3 class="mp-card__title">Open with Komika</h3>
          </div>
        </div>
        <p class="mp-card__body mp-text--secondary">
          File associations across platforms, second-instance path queueing, and Linux XDG
          desktop integration from settings.
        </p>
      </article>
      <article class="mp-card mp-card--oracle">
        <div class="mp-card__header">
          <div>
            <p class="mp-card__eyebrow">Documents</p>
            <h3 class="mp-card__title">PDF &amp; Markdown</h3>
          </div>
        </div>
        <p class="mp-card__body mp-text--secondary">
          pdf.js pages in the reader strip, Markdown via Merak’s markdown renderer, with webtoon
          layout retention for multi-page PDFs.
        </p>
      </article>
    </div>
  </section>

  <section class="site-section" id="formats" aria-labelledby="formats-title">
    <div class="mp-section-heading">
      <p class="mp-eyebrow">Formats</p>
      <h2 id="formats-title">One reader, many sources</h2>
      <p class="mp-text--secondary">Drag and drop a single file or folder onto the window.</p>
    </div>
    <div class="mp-grid site-format-grid">
      ${formatCard("Archives", "CBZ / ZIP, CBR / RAR, CB7 / 7z")}
      ${formatCard("Images", "PNG, JPEG, WebP, animated GIF · folders")}
      ${formatCard("Video", "WebM, MP4, MOV")}
      ${formatCard("Audio", "MP3, M4A, AAC, OGG, Opus, WAV")}
      ${formatCard("Documents", "PDF · Markdown")}
      ${formatCard("Delivery", "RPC ≤32 MiB · stream larger · archive temp ≤2 GiB")}
    </div>
  </section>

  <section class="site-section" id="release" aria-labelledby="release-title">
    <div class="mp-section-heading">
      <p class="mp-eyebrow">Release</p>
      <h2 id="release-title">What’s new in v0.2.1</h2>
      <p class="mp-text--secondary">
        Since
        <a href="${RELEASE_V010}">v0.1.0</a>
        — media hardening, open-with, and Debian 13 packaging images.
      </p>
    </div>
    <div class="mp-grid mp-grid--wide mp-grid--start">
      <article class="mp-card">
        <div class="mp-card__header">
          <div>
            <p class="mp-card__eyebrow">Highlights</p>
            <h3 class="mp-card__title">Playback · Open with · Packaging</h3>
          </div>
        </div>
        <ul class="site-list mp-text--secondary">
          <li>ffmpeg / wasm codec fallbacks and WebKitGTK HTTP Range delivery</li>
          <li>MP4 faststart, stall watchdog, soft-loop, diagnostics UI</li>
          <li>AppImage GStreamer inject; tighter Linux package codec depends</li>
          <li>OS file associations and Linux XDG integration</li>
          <li>
            Docker multi-arch packaging:
            <code class="site-code">package:docker:setup</code> /
            <code class="site-code">package:docker</code>
          </li>
        </ul>
        <div class="mp-card__actions mp-button-row">
          <a class="mp-button mp-button--primary mp-button--sm" href="${RELEASE_V021}">GitHub Release</a>
          <a class="mp-button mp-button--secondary mp-button--sm" href="${DOCS_V021}">Full notes</a>
        </div>
      </article>
      <aside class="mp-card mp-card--relic">
        <div class="mp-card__header">
          <div>
            <p class="mp-card__eyebrow">Linux codecs</p>
            <h3 class="mp-card__title">Install on the host</h3>
          </div>
        </div>
        <p class="mp-card__body mp-text--secondary">
          For native binaries and packages, install GStreamer <strong>libav + plugins-good</strong>
          (and preferably base/bad/ugly + tools) for H.264/AAC in WebKitGTK, plus <strong>ffmpeg</strong>
          for the transcoder fallback. AppImages bundle plugins when built with
          <code class="site-code">task package</code>.
        </p>
      </aside>
    </div>
  </section>

  <section class="site-section site-section--get" id="get" aria-labelledby="get-title">
    <div class="site-get mp-card">
      <div class="site-get__copy">
        <p class="mp-eyebrow">Get Komika</p>
        <h2 id="get-title">Download builds or build from source</h2>
        <p class="mp-text--secondary">
          Release assets cover Windows, Linux, and macOS. Developers can package with the root
          Taskfile or Debian 13 <code class="site-code">komika-package</code> Docker images.
        </p>
        <div class="mp-button-row">
          <a class="mp-button mp-button--primary" href="${RELEASES}">All releases</a>
          <a class="mp-button mp-button--secondary" href="${GH}#task-workflow">Build docs</a>
        </div>
      </div>
      <pre class="site-terminal" tabindex="0"><code># Package on the host
wails3 task package

# Or multi-arch packaging images (Debian 13)
wails3 task package:docker:setup ARCH=amd64
wails3 task package:docker GOOS=linux ARCH=amd64
wails3 task package:docker GOOS=windows ARCH=amd64</code></pre>
    </div>
  </section>
</main>

<footer class="site-footer">
  <div class="site-footer__brand">
    <img src="./komika-mark.png" width="28" height="28" alt="" />
    <span>Komika</span>
  </div>
  <p class="mp-text--muted site-footer__meta">
    Local-first comic reader · UI primitives from
    <a href="https://css.saturday.ne.kr">Merak Protocol Design System</a>
  </p>
  <div class="site-footer__links">
    <a href="${GH}">GitHub</a>
    <a href="${RELEASES}">Releases</a>
    <a href="${GH}/blob/main/README.md">README</a>
  </div>
</footer>
`;

function formatCard(title, body) {
  return `
    <article class="mp-card site-format-card">
      <div class="mp-card__header">
        <div>
          <p class="mp-card__eyebrow">Support</p>
          <h3 class="mp-card__title">${title}</h3>
        </div>
      </div>
      <p class="mp-card__body mp-text--secondary">${body}</p>
    </article>
  `;
}
