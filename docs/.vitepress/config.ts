import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "🔒 SyncGuard",
  base: "/syncguard/",
  description:
    "TypeScript distributed lock library that prevents race conditions across services. Because nobody wants their payment processed twice! 💸",
  lang: "en-US",
  lastUpdated: true,
  cleanUrls: true,
  sitemap: {
    hostname: "https://kriasoft.com/syncguard/",
    lastmodDateOnly: false,
  },
  head: [
    ["link", { rel: "icon", href: "/syncguard/favicon.ico" }],
    ["meta", { name: "theme-color", content: "#3c8772" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:locale", content: "en" }],
    [
      "meta",
      {
        property: "og:title",
        content: "SyncGuard | Distributed Locks for TypeScript",
      },
    ],
    ["meta", { property: "og:site_name", content: "SyncGuard" }],
    [
      "meta",
      { property: "og:url", content: "https://kriasoft.com/syncguard/" },
    ],
    [
      "meta",
      {
        property: "og:image",
        content: "https://kriasoft.com/syncguard/og-image.webp",
      },
    ],
  ],
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: "Guide", link: "/what-is-syncguard" },
      { text: "Backends", link: "/redis" },
      { text: "Reference", link: "/api" },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern: "https://github.com/kriasoft/syncguard/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "What is SyncGuard?", link: "/what-is-syncguard" },
          { text: "Getting Started", link: "/getting-started" },
          { text: "Core Concepts", link: "/core-concepts" },
          { text: "Fencing Tokens", link: "/fencing" },
        ],
      },
      {
        text: "Backends",
        items: [
          { text: "Redis", link: "/redis" },
          { text: "Firestore", link: "/firestore" },
        ],
      },
      {
        text: "API",
        items: [{ text: "API Reference", link: "/api" }],
      },
      {
        text: "For Developers",
        items: [
          {
            text: "Specifications",
            link: "https://github.com/kriasoft/syncguard/tree/main/specs",
          },
          {
            text: "Architecture Decisions",
            link: "https://github.com/kriasoft/syncguard/blob/main/specs/adrs.md",
          },
          {
            text: "Contributing",
            link: "https://github.com/kriasoft/syncguard/blob/main/.github/CONTRIBUTING.md",
          },
          {
            text: "Security Policy",
            link: "https://github.com/kriasoft/syncguard/blob/main/.github/SECURITY.md",
          },
          {
            text: "Sponsor",
            link: "https://github.com/sponsors/koistya",
          },
        ],
      },
    ],

    socialLinks: [
      { icon: "x", link: "https://x.com/kriasoft" },
      { icon: "discord", link: "https://discord.gg/EnbEa7Gsxg" },
      { icon: "github", link: "https://github.com/kriasoft/syncguard" },
    ],

    footer: {
      message:
        'Released under the <a href="https://github.com/kriasoft/syncguard/blob/main/LICENSE">MIT License</a>.',
      copyright:
        'Copyright © 2025-present <a href="https://kriasoft.com" target="_self">Kriasoft</a> · Created by <a href="https://github.com/koistya">Konstantin Tarkus</a>',
    },
  },
});
