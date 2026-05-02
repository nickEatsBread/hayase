import { fontFamily } from 'tailwindcss/defaultTheme'
import plugin from 'tailwindcss/plugin'

import type { Config } from 'tailwindcss'

const config: Config = {
  plugins: [
    plugin((api) => {
      api.addVariant('select', ['&:hover', '&:focus-visible', '&:active'])
      api.addVariant('group-select', [':merge(.group):hover &', ':merge(.group):focus-visible &', ':merge(.group):active &'])
      api.addVariant('fullscreen', '&:fullscreen')
      api.addVariant('group-fullscreen', ':merge(.group):fullscreen &')
      api.matchVariant(
        'group-fullscreen',
        (value, { modifier }) => [
          ':merge(.group):fullscreen &',
          `:merge(.group\\/${modifier}):fullscreen &`
        ],
        { values: { DEFAULT: undefined } }
      )
      api.matchVariant(
        'group-select',
        (value, { modifier }) => [
          ':merge(.group):hover &',
          `:merge(.group\\/${modifier}):hover &`,
          ':merge(.group):focus-visible &',
          `:merge(.group\\/${modifier}):focus-visible &`,
          ':merge(.group):active &',
          `:merge(.group\\/${modifier}):active &`
        ],
        { values: { DEFAULT: undefined } }
      )
      api.addVariant('mobile', '@media (pointer: none), (pointer: coarse)')
      api.matchUtilities(
        {
          'view-transition': (value) => ({
            'view-transition-name': value
          })
        },
        {
          values: { DEFAULT: 'auto' },
          type: 'any'
        }
      )
    })
  ],
  darkMode: ['class'],
  content: ['./src/**/*.{html,js,svelte,ts}'],
  safelist: ['dark'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
        xs: '480px'
      }
    },
    extend: {
      colors: {
        custom: {
          DEFAULT: 'hsl(from var(--custom) h s l / <alpha-value>)',
          50: 'hsl(from var(--custom) h s 95% / <alpha-value>)',
          100: 'hsl(from var(--custom) h s 90% / <alpha-value>)',
          200: 'hsl(from var(--custom) h s 80% / <alpha-value>)',
          300: 'hsl(from var(--custom) h s 70% / <alpha-value>)',
          400: 'hsl(from var(--custom) h s 60% / <alpha-value>)',
          500: 'hsl(from var(--custom) h s l / <alpha-value>)',
          600: 'hsl(from var(--custom) h s 40% / <alpha-value>)',
          700: 'hsl(from var(--custom) h s 30% / <alpha-value>)',
          800: 'hsl(from var(--custom) h s 20% / <alpha-value>)',
          900: 'hsl(from var(--custom) h s 10% / <alpha-value>)',
          950: 'hsl(from var(--custom) h s 5% / <alpha-value>)'
        },
        theme: 'hsl(346.6deg 79.12% 51.18% / <alpha-value>)',
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)'
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)'
        }
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      fontFamily: {
        sans: [...fontFamily.sans]
      },
      screens: {
        '2xl': '1400px',
        xs: '480px'
      }
    }
  }
}

export default config
