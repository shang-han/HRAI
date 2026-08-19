/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#4F46E5',
        primaryLight: '#818CF8',
        danger: '#F53F3F',
        warning: '#FF7D00',
        success: '#00B42A',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif']
      }
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  }
}
