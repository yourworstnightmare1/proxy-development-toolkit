"use strict";

const fs = require("fs");
const path = require("path");
const { modulePath } = require("./paths");

const ENTRIES = [
  {
    id: "ultraviolet",
    title: "Ultraviolet",
    author: "titaniumnetwork-dev",
    authorUrl: "https://github.com/titaniumnetwork-dev",
    sourceUrl: "https://github.com/titaniumnetwork-dev/Ultraviolet",
    licenseLabel: "GNU Affero General Public License v3",
    package: ["@titaniumnetwork-dev", "ultraviolet", "LICENSE"],
  },
  {
    id: "scramjet",
    title: "Scramjet",
    author: "MercuryWorkshop",
    authorUrl: "https://github.com/MercuryWorkshop",
    sourceUrl: "https://github.com/MercuryWorkshop/scramjet",
    licenseLabel: "No license",
    note: "This software has no license.",
    package: ["@mercuryworkshop", "scramjet", "LICENSE"],
  },
  {
    id: "epoxy-tls",
    title: "epoxy-tls",
    author: "MercuryWorkshop",
    authorUrl: "https://github.com/MercuryWorkshop",
    sourceUrl: "https://github.com/MercuryWorkshop/epoxy-tls",
    licenseLabel: "No license",
    note: "This software has no license.",
    package: ["@mercuryworkshop", "epoxy-tls", "LICENSE"],
  },
  {
    id: "wisp-js",
    title: "wisp-js",
    author: "MercuryWorkshop",
    authorUrl: "https://github.com/MercuryWorkshop",
    sourceUrl: "https://github.com/MercuryWorkshop/wisp-js",
    licenseLabel: "GNU Lesser General Public License v3",
    package: ["@mercuryworkshop", "wisp-js", "LICENSE"],
  },
  {
    id: "libcurl-transport",
    title: "libcurl-transport",
    author: "MercuryWorkshop",
    authorUrl: "https://github.com/MercuryWorkshop",
    sourceUrl: "https://github.com/MercuryWorkshop/libcurl-transport",
    licenseLabel: "GNU Affero General Public License v3",
    package: ["@mercuryworkshop", "libcurl-transport", "LICENSE"],
  },
  {
    id: "bare-transport",
    title: "bare-transport",
    author: "MercuryWorkshop",
    authorUrl: "https://github.com/MercuryWorkshop",
    sourceUrl: "https://github.com/MercuryWorkshop/bare-transport",
    licenseLabel: "GNU Lesser General Public License v3",
    package: ["@mercuryworkshop", "bare-transport", "LICENSE"],
  },
  {
    id: "bare-mux",
    title: "bare-mux",
    author: "MercuryWorkshop",
    authorUrl: "https://github.com/MercuryWorkshop",
    sourceUrl: "https://github.com/MercuryWorkshop/bare-mux",
    licenseLabel: "MIT License",
    package: ["@mercuryworkshop", "bare-mux", "LICENSE"],
  },
];

function readLicense(entry) {
  if (entry.note && entry.licenseLabel === "No license") {
    try {
      const file = modulePath(...entry.package);
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    } catch { /* fall through */ }
    return entry.note;
  }
  try {
    const file = modulePath(...entry.package);
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  } catch { /* ignore */ }
  return entry.note || `License text for ${entry.title} was not found in this install. See ${entry.sourceUrl}`;
}

function list() {
  return ENTRIES.map((entry) => ({
    id: entry.id,
    title: entry.title,
    author: entry.author,
    authorUrl: entry.authorUrl,
    sourceUrl: entry.sourceUrl,
    licenseLabel: entry.licenseLabel,
  }));
}

function licenseText(id) {
  const entry = ENTRIES.find((item) => item.id === id);
  if (!entry) return null;
  return {
    ...list().find((item) => item.id === id),
    text: readLicense(entry),
  };
}

module.exports = { list, licenseText, ENTRIES };
