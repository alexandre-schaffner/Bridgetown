// The download buttons. The link never goes stale: GitHub's latest/download URL always serves the
// newest published DMG. The version and size beside it are looked up once, at build time, and
// left out if GitHub can't be reached; release.yml redeploys the site after every release.

import { site } from "../site";

const asset = "Bridgetown.dmg";

export interface Download {
  url: string;
  /** `v0.2.0 · 14 MB · Apple silicon · macOS 14+`, as much of it as is known. */
  meta: string;
  notes: string;
}

interface Release {
  tag_name: string;
  html_url: string;
  assets: { name: string; size: number }[];
}

async function latest(): Promise<Release | null> {
  const token = process.env.GITHUB_TOKEN;
  try {
    const res = await fetch(`https://api.github.com/repos/${site.repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? ((await res.json()) as Release) : null;
  } catch {
    return null;
  }
}

const release = await latest();
const dmg = release?.assets.find((a) => a.name === asset);

export const download: Download = {
  url: `https://github.com/${site.repo}/releases/latest/download/${asset}`,
  meta: [release?.tag_name, dmg && `${Math.round(dmg.size / 1e6)} MB`, "Apple silicon", "macOS 14+"]
    .filter(Boolean)
    .join(" · "),
  notes: release?.html_url ?? `https://github.com/${site.repo}/releases`,
};
