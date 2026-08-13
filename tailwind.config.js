/**
 * Tailwind build configuration.
 *
 * The four web pages used to load https://cdn.tailwindcss.com, which is the
 * Play CDN: it ships a compiler to the browser, scans the DOM and generates
 * the stylesheet at runtime, on every load, on the cashier's phone. Tailwind's
 * own documentation says it is for development only. It also meant an outage
 * or a blocked CDN left the app unstyled, and it cost a render-blocking
 * request plus a compile before anything appeared.
 *
 * `npm run build:css` turns this into assets/css/app.css, which is committed.
 * Cloudflare Pages serves this repository with no build step, so the generated
 * file has to be in it — and because it is generated from the pages
 * themselves, regenerating it is the whole maintenance story:
 *
 *     npm install --no-save tailwindcss@3.4.17
 *     npm run build:css
 *
 * The check is `npm run lint`, which fails if a page reaches for the CDN again
 * or uses a class the committed stylesheet does not define.
 */
module.exports = {
  content: [
    './*.html',
    './assets/**/*.js'
  ],
  theme: {
    extend: {}
  },
  plugins: []
};
