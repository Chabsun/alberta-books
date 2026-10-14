import { useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'alberta-books-theme'

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function apply(choice: ThemeChoice) {
  const dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function initTheme(): void {
  apply(read())
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply(read()))
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read)
  useEffect(() => apply(choice), [choice])
  return [
    choice,
    (t) => {
      try {
        localStorage.setItem(KEY, t)
      } catch {
        // theme just won't persist
      }
      setChoice(t)
    }
  ]
}
