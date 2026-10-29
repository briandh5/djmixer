/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Chakra Petch"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        carbon: { 950: '#060607', 900: '#0b0b0d', 850: '#101013', 800: '#141418', 700: '#1c1c21', 600: '#26262d', 500: '#3a3a44', 400: '#5b5b68', 300: '#8a8a98', 200: '#b9b9c6' },
        neon: { cyan: '#19f0ff', magenta: '#ff2bd6', green: '#3dff8e', amber: '#ffb020' },
      },
    },
  },
  plugins: [],
}
