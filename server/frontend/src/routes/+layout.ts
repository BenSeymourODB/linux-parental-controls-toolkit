// Static-only scaffold: every route is prerendered to HTML at build time and
// served by the Fastify backend (see ../../README.md). Real /admin UI lands in
// Phase 2; the real /app PWA lands in Phase 9. Setting `prerender` here applies
// it to every page in the project, so the build emits real HTML (not just an
// app shell).
export const prerender = true;
