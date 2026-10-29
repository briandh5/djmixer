// Empaqueta la app en un solo HTML (React incluido) para la vista previa en Artifacts.
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

mkdirSync('dist-artifact', { recursive: true })
execSync('npx tailwindcss -i src/index.css -o dist-artifact/app.css --minify', { stdio: 'inherit' })
await build({
  entryPoints: ['src/artifact-entry.jsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: 'dist-artifact/app.js',
})
const css = readFileSync('dist-artifact/app.css', 'utf8')
const js = readFileSync('dist-artifact/app.js', 'utf8').replace(/<\/script/g, '<\\/script')
const html = readFileSync('index.html', 'utf8')
  .replace('<script type="module" src="/src/main.jsx"></script>', () => `<script>${js}</script>`)
  .replace('</head>', () => `<meta name="claude:viewport-fit-sides" content="cover" /><style>${css}</style></head>`)
writeFileSync('dist-artifact/dj-mixer.html', html)
console.log('dist-artifact/dj-mixer.html listo')
