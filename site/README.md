# Komika marketing site

Static landing page built with [Merak Protocol Design System](https://css.saturday.ne.kr) and brand assets from `build/brand/`.

## Develop

```bash
cd site
npm install
npm run dev      # http://127.0.0.1:5177
npm run build    # → site/dist
npm run preview
```

## Notes

`vite.config.js` sets `base: "./"` and public assets use relative URLs (`./komika-*.png|webp`) so the build works on a domain root (**komika.saturday.ne.kr**) or a future subpath host (e.g. GitHub Pages `/komika/`).

- CSS-only Merak surface (`mp-*` components); no app runtime.
- Logo / mark copies live under `site/public/` (source of truth remains `build/brand/`).
- Release CTAs point at GitHub Releases (`snowmerak/komika`).
