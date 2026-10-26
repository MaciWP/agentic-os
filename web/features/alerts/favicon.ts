// The tab's icon: the app's mark, with the number of things waiting on the user in an amber
// badge, so a tab among many still says it. Drawn as SVG; there is no icon file to ship.

// «Órbita» on the brand gradient, as `.brand-mark` in tokens.css draws it (in hex: a data URL
// sees no CSS variables, so the tab keeps the brand colours, not the block accent).
const MARK =
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a87fd"/><stop offset="1" stop-color="#b740b1"/></linearGradient>' +
  '<radialGradient id="h" cx="0.2" cy="0" r="0.75"><stop offset="0" stop-color="#b6b3ff"/><stop offset="1" stop-color="#b6b3ff" stop-opacity="0"/></radialGradient></defs>' +
  '<rect width="32" height="32" rx="9" fill="url(#g)"/><rect width="32" height="32" rx="9" fill="url(#h)"/>' +
  '<g transform="translate(4 4)" fill="#fff"><circle cx="12" cy="12.6" r="6.6" fill="none" stroke="#fff" stroke-width="1.8" opacity="0.6"/>' +
  '<circle cx="12" cy="6" r="2.9"/><circle cx="6.3" cy="15.9" r="2.9"/><circle cx="17.7" cy="15.9" r="2.9"/></g>';

export function faviconSvg(count: number): string {
  const badge =
    count > 0
      ? '<circle cx="24" cy="8" r="8" fill="#f2a93b" stroke="#16161c" stroke-width="2"/>' +
        `<text x="24" y="12" font-family="system-ui,sans-serif" font-size="${count > 9 ? 9 : 12}" font-weight="700" text-anchor="middle" fill="#16161c">${count > 9 ? "9+" : count}</text>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${MARK}${badge}</svg>`;
}

export function setFavicon(count: number) {
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.type = "image/svg+xml";
  link.href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(count))}`;
}
