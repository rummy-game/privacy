import { defineConfig } from 'astro/config';

// GitHub Pages: https://rummy-game.github.io/privacy/ (Organisation rummy-game, Repo privacy)
export default defineConfig({
  site: 'https://rummy-game.github.io',
  base: '/privacy',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
