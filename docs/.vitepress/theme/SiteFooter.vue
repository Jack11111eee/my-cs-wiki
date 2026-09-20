<template>
  <footer class="site-footer">
    <p>
      Copyright © 2026 Jackkkkk1e
      <span class="separator" aria-hidden="true">·</span>
      Content licensed under
      <a
        href="https://creativecommons.org/licenses/by-nc-nd/4.0/"
        rel="license"
        target="_blank"
      >CC BY-NC-ND 4.0</a>
    </p>
    <p>
      Contact:
      <a href="mailto:jackkkkk1e@proton.me">jackkkkk1e@proton.me</a>
    </p>
  </footer>
</template>

<style scoped>
.site-footer {
  position: relative;
  z-index: 4;
  flex: none;
  border-top: 1px solid var(--vp-c-divider);
  padding: 24px;
  text-align: center;
  color: var(--vp-c-text-2);
}

.site-footer p {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 24px;
}

.site-footer a {
  color: var(--wiki-link);
  text-decoration: underline;
  text-decoration-color: var(--wiki-accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
  transition: color 0.25s ease;
}

.site-footer a:hover {
  color: var(--vp-c-text-1);
}

.separator {
  margin: 0 0.35em;
}

@media (max-width: 639px) {
  .site-footer {
    padding: 20px 16px;
  }
}
</style>
