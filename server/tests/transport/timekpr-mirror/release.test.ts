/**
 * Tests for the pure Launchpad-PPA release coordinates (#392): URL builders,
 * zod validation of the `getPublishedBinaries` / `binaryFileUrls` responses, and
 * the latest/pinned/`.deb`-URL selection helpers. No I/O — the fetch module is
 * tested separately with injected seams.
 */
import { describe, expect, it } from "vitest";

import {
  DEB_AR_MAGIC,
  TIMEKPR_PPA_NAME,
  TIMEKPR_PPA_OWNER,
  TimekprMirrorResolveError,
  binaryFileUrlsSchema,
  binaryFileUrlsUrl,
  debFilename,
  parseLatestPublication,
  publishedBinariesSchema,
  publishedBinariesUrl,
  selectDebUrl,
  selectPinnedPublication,
} from "../../../src/transport/timekpr-mirror/release.js";

const PKG = "timekpr-next";
const SELF = "https://api.launchpad.net/devel/~mjasnik/+archive/ubuntu/ppa/+binarypub/1";

function collection(entries: { version: string; self?: string }[]) {
  return publishedBinariesSchema.parse({
    entries: entries.map((e) => ({
      binary_package_name: PKG,
      binary_package_version: e.version,
      self_link: e.self ?? SELF,
    })),
  });
}

describe("publishedBinariesUrl", () => {
  it("targets the mjasnik PPA with the scoping query params", () => {
    const url = publishedBinariesUrl(PKG);
    expect(url).toContain(`~${TIMEKPR_PPA_OWNER}/+archive/ubuntu/${TIMEKPR_PPA_NAME}`);
    expect(url).toContain("ws.op=getPublishedBinaries");
    expect(url).toContain(`binary_name=${PKG}`);
    expect(url).toContain("status=Published");
    expect(url).toContain("exact_match=true");
    expect(url).toContain("order_by_date=true");
    expect(url).toContain("ws.size=");
  });
});

describe("binaryFileUrlsUrl", () => {
  it("appends the op with ? when the self link has no query", () => {
    expect(binaryFileUrlsUrl(SELF)).toBe(`${SELF}?ws.op=binaryFileUrls`);
  });

  it("appends the op with & when the self link already has a query", () => {
    expect(binaryFileUrlsUrl(`${SELF}?foo=bar`)).toBe(`${SELF}?foo=bar&ws.op=binaryFileUrls`);
  });
});

describe("publishedBinariesSchema", () => {
  it("strips unknown Launchpad fields and keeps the ones we use", () => {
    const parsed = publishedBinariesSchema.parse({
      entries: [
        {
          binary_package_name: PKG,
          binary_package_version: "0.5.7-1",
          self_link: SELF,
          component_name: "main",
          status: "Published",
        },
      ],
    });
    expect(parsed.entries[0]).toEqual({
      binary_package_name: PKG,
      binary_package_version: "0.5.7-1",
      self_link: SELF,
    });
  });

  it("rejects a body missing a required field", () => {
    expect(() =>
      publishedBinariesSchema.parse({ entries: [{ binary_package_version: "0.5.7-1" }] }),
    ).toThrow();
  });
});

describe("parseLatestPublication", () => {
  it("returns the first (most recently published) entry", () => {
    const latest = parseLatestPublication(
      collection([{ version: "0.5.7-1" }, { version: "0.5.6-1" }]),
    );
    expect(latest.binary_package_version).toBe("0.5.7-1");
  });

  it("throws a resolve error when the collection is empty", () => {
    expect(() => parseLatestPublication(collection([]))).toThrow(TimekprMirrorResolveError);
  });
});

describe("selectPinnedPublication", () => {
  it("returns the entry matching the pinned version", () => {
    const pinned = selectPinnedPublication(
      collection([{ version: "0.5.7-1" }, { version: "0.5.6-1" }]),
      "0.5.6-1",
    );
    expect(pinned.binary_package_version).toBe("0.5.6-1");
  });

  it("throws a resolve error when the pin is not published", () => {
    expect(() => selectPinnedPublication(collection([{ version: "0.5.7-1" }]), "0.4.0-1")).toThrow(
      TimekprMirrorResolveError,
    );
  });
});

describe("debFilename", () => {
  it("builds the arch-independent .deb name", () => {
    expect(debFilename(PKG, "0.5.7-1")).toBe("timekpr-next_0.5.7-1_all.deb");
  });
});

describe("selectDebUrl", () => {
  const base = "https://launchpad.net/~mjasnik/+archive/ubuntu/ppa/+files";

  it("picks the _all.deb URL for the exact version", () => {
    const urls = binaryFileUrlsSchema.parse([
      `${base}/timekpr-next_0.5.7-1.dsc`,
      `${base}/timekpr-next_0.5.7-1_all.deb`,
    ]);
    expect(selectDebUrl(urls, PKG, "0.5.7-1")).toBe(`${base}/timekpr-next_0.5.7-1_all.deb`);
  });

  it("matches by basename even when the URL carries a query string", () => {
    const urls = binaryFileUrlsSchema.parse([`${base}/timekpr-next_0.5.7-1_all.deb?token=abc`]);
    expect(selectDebUrl(urls, PKG, "0.5.7-1")).toBe(
      `${base}/timekpr-next_0.5.7-1_all.deb?token=abc`,
    );
  });

  it("throws a resolve error when no matching .deb is present", () => {
    const urls = binaryFileUrlsSchema.parse([`${base}/timekpr-next_0.5.6-1_all.deb`]);
    expect(() => selectDebUrl(urls, PKG, "0.5.7-1")).toThrow(TimekprMirrorResolveError);
  });
});

describe("DEB_AR_MAGIC", () => {
  it("is the Debian ar global header", () => {
    expect(DEB_AR_MAGIC).toBe("!<arch>\n");
  });
});
