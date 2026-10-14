import { useEffect, type ReactNode } from 'react'
import {
  BarChart3,
  BookOpen,
  Bot,
  Car,
  CalendarCheck,
  FolderInput,
  FileText,
  Landmark,
  LayoutDashboard,
  ListTree,
  Monitor,
  Moon,
  Percent,
  Receipt,
  Settings as SettingsIcon,
  Sun,
  Users
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { FeedbackProvider } from './components/feedback'
import { cx } from './components/ui'
import { invalidate, useQuery } from './lib/api'
import { match, navigate, usePath } from './lib/router'
import { useTheme, type ThemeChoice } from './lib/theme'
import Dashboard from './pages/Dashboard'
import Invoices from './pages/Invoices'
import InvoiceEditor from './pages/InvoiceEditor'
import InvoiceDetail from './pages/InvoiceDetail'
import Clients from './pages/Clients'
import Expenses from './pages/Expenses'
import BankFeed from './pages/BankFeed'
import Vehicle from './pages/Vehicle'
import YearEnd from './pages/YearEnd'
import Ai from './pages/Ai'
import Migrate from './pages/Migrate'
import Journal from './pages/Journal'
import Accounts from './pages/Accounts'
import AccountLedger from './pages/AccountLedger'
import Reports from './pages/Reports'
import Gst from './pages/Gst'
import Settings from './pages/Settings'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const NAV: { heading?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Overview', icon: LayoutDashboard }] },
  {
    heading: 'Money in',
    items: [
      { to: '/invoices', label: 'Invoices', icon: FileText },
      { to: '/clients', label: 'Clients', icon: Users }
    ]
  },
  {
    heading: 'Money out',
    items: [
      { to: '/bank', label: 'Bank feed', icon: Landmark },
      { to: '/expenses', label: 'Expenses', icon: Receipt },
      { to: '/vehicle', label: 'Company vehicle', icon: Car }
    ]
  },
  {
    heading: 'Books',
    items: [
      { to: '/journal', label: 'Journal', icon: BookOpen },
      { to: '/accounts', label: 'Chart of accounts', icon: ListTree },
      { to: '/reports', label: 'Reports', icon: BarChart3 },
      { to: '/gst', label: 'GST return', icon: Percent },
      { to: '/year-end', label: 'Year end', icon: CalendarCheck }
    ]
  },
  {
    heading: 'Connect',
    items: [
      { to: '/ai', label: 'AI assistants', icon: Bot },
      { to: '/migrate', label: 'QuickBooks / Zoho', icon: FolderInput }
    ]
  }
]

function route(path: string): ReactNode {
  const p = path.split('?')[0]
  let m: Record<string, string> | null
  if (p === '/') return <Dashboard />
  if (p === '/invoices') return <Invoices />
  if (p === '/invoices/new') return <InvoiceEditor key="new" />
  if ((m = match('/invoices/:id/edit', p))) return <InvoiceEditor key={m.id} id={Number(m.id)} />
  if ((m = match('/invoices/:id', p))) return <InvoiceDetail key={m.id} id={Number(m.id)} />
  if (p === '/clients') return <Clients />
  if (p === '/expenses') return <Expenses />
  if (p === '/bank' || p === '/bank-import') return <BankFeed />
  if (p === '/vehicle') return <Vehicle />
  if (p === '/year-end') return <YearEnd />
  if (p === '/ai') return <Ai />
  if (p === '/migrate') return <Migrate />
  if (p === '/journal') return <Journal />
  if (p === '/accounts') return <Accounts />
  if ((m = match('/accounts/:id', p))) return <AccountLedger key={m.id} id={Number(m.id)} />
  if (p === '/reports') return <Reports />
  if (p === '/gst') return <Gst />
  if (p === '/settings') return <Settings />
  return <Dashboard />
}

function isActive(to: string, path: string): boolean {
  const p = path.split('?')[0]
  return to === '/' ? p === '/' : p === to || p.startsWith(`${to}/`)
}

function NavLink({ item, path }: { item: NavItem; path: string }) {
  const active = isActive(item.to, path)
  const Icon = item.icon
  return (
    <a
      href={`#${item.to}`}
      onClick={(e) => {
        e.preventDefault()
        navigate(item.to)
      }}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'no-drag flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors',
        active ? 'bg-surface font-medium text-ink shadow-xs ring-1 ring-line' : 'text-muted hover:bg-hover hover:text-ink'
      )}
    >
      <Icon className={cx('size-4', active ? 'text-accent' : '')} strokeWidth={active ? 2.2 : 1.9} />
      {item.label}
    </a>
  )
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme()
  const options: { value: ThemeChoice; icon: LucideIcon; label: string }[] = [
    { value: 'light', icon: Sun, label: 'Light' },
    { value: 'system', icon: Monitor, label: 'Match system' },
    { value: 'dark', icon: Moon, label: 'Dark' }
  ]
  return (
    <div className="no-drag flex rounded-lg bg-subtle p-0.5 ring-1 ring-line">
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cx(
            'flex h-6 flex-1 items-center justify-center rounded-md transition-colors',
            theme === value ? 'bg-surface text-ink shadow-xs ring-1 ring-line' : 'text-faint hover:text-ink'
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  )
}

function Sidebar({ path }: { path: string }) {
  const settings = useQuery('settings.get')
  const isMac = window.books.platform === 'darwin'
  return (
    <aside className={cx('flex w-[232px] shrink-0 flex-col border-r border-line bg-canvas', isMac && 'drag')}>
      <div className={cx('px-4 pb-4', isMac ? 'pt-12' : 'pt-5')}>
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-ink shadow-sm">
            <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 19V9l8-5 8 5v10" />
              <path d="M9 19v-6h6v6" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold leading-tight text-ink">{settings.data?.companyName ?? 'Alberta Books'}</div>
            <div className="text-[11.5px] leading-tight text-faint">Alberta Books · GST 5%</div>
          </div>
        </div>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3" aria-label="Main">
        {NAV.map((group, i) => (
          <div key={i} className="space-y-0.5">
            {group.heading ? <div className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{group.heading}</div> : null}
            {group.items.map((item) => (
              <NavLink key={item.to} item={item} path={path} />
            ))}
          </div>
        ))}
      </nav>
      <div className="space-y-3 border-t border-line px-3 py-3">
        <NavLink item={{ to: '/settings', label: 'Settings', icon: SettingsIcon }} path={path} />
        <ThemeSwitch />
      </div>
    </aside>
  )
}

export default function App() {
  const path = usePath()
  // An AI assistant changed the books: refresh what's on screen.
  useEffect(() => window.books.onChanged(invalidate), [])
  return (
    <FeedbackProvider>
      <div className="flex h-full">
        <Sidebar path={path} />
        <main className="min-w-0 flex-1 overflow-y-auto bg-canvas" key={path.split('?')[0]}>
          {route(path)}
        </main>
      </div>
    </FeedbackProvider>
  )
}
