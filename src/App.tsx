import * as React from 'react'
import { AlertTriangle, FlaskConical } from 'lucide-react'
import { LiveProvider, useLive } from '@/state/live'
import { Sidebar, type Page } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { SaleToasts } from '@/components/SaleToasts'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Overview } from '@/pages/Overview'
import { Players } from '@/pages/Players'
import { Revenue } from '@/pages/Revenue'
import { Activity } from '@/pages/Activity'
import { DataSources } from '@/pages/DataSources'
import { Admin } from '@/pages/Admin'
import { Login } from '@/pages/Login'
import { apiFetch, setUnauthorizedHandler } from '@/lib/api'

const PAGES: Page[] = ['overview', 'players', 'revenue', 'activity', 'sources', 'admin']
const TITLES: Record<Page, string> = { overview: 'Overview', players: 'Players', revenue: 'Revenue', activity: 'Activity', sources: 'Data sources', admin: 'Admin' }

function pageFromHash(): Page {
  const h = location.hash.replace(/^#\/?/, '') as Page
  return PAGES.includes(h) ? h : 'overview'
}

function Shell() {
  const { live, bootError, reload } = useLive()
  const [page, setPage] = React.useState<Page>(pageFromHash)
  const [menu, setMenu] = React.useState(false)
  React.useEffect(() => {
    const on = () => setPage(pageFromHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  React.useEffect(() => {
    document.title = `${TITLES[page]} · Roadster Life Analytics`
  }, [page])
  const navigate = (p: Page) => {
    location.hash = `/${p}`
    setPage(p)
    window.scrollTo({ top: 0 })
  }
  return (
    <div className="flex min-h-screen">
      <Sidebar page={page} onNavigate={navigate} open={menu} onClose={() => setMenu(false)} />
      <div className="min-w-0 flex-1">
        <Header onMenu={() => setMenu(true)} />
        <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-xl font-semibold tracking-tight">{TITLES[page]}</h2>
          </div>
          {live?.mode === 'development' ? (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[13px] text-warning" role="alert">
              <FlaskConical className="size-4 shrink-0" />
              <span>
                <b>Development mode.</b> Statistics include explicitly labelled synthetic test events. Set APP_MODE=production before relying on these numbers.
              </span>
            </div>
          ) : null}
          {live && live.budget.level !== 'ok' ? (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[13px] text-warning" role="alert">
              <AlertTriangle className="size-4 shrink-0" />
              <span>{live.budget.messages.join(' ')}</span>
            </div>
          ) : null}
          {bootError ? (
            <div className="rounded-xl border border-critical/30 bg-critical/10 p-5 text-sm text-[#ff9b9b]">
              <p className="font-semibold">Could not load the dashboard</p>
              <p className="mt-1">{bootError}</p>
              <Button variant="secondary" className="mt-3" onClick={reload}>
                Try again
              </Button>
            </div>
          ) : (
            <>
              {page === 'overview' && <Overview />}
              {page === 'players' && <Players />}
              {page === 'revenue' && <Revenue />}
              {page === 'activity' && <Activity />}
              {page === 'sources' && <DataSources />}
              {page === 'admin' && <Admin />}
            </>
          )}
        </main>
      </div>
      <SaleToasts />
    </div>
  )
}

export function App() {
  const [auth, setAuth] = React.useState<{ authenticated: boolean; mode: string; reason: string | null } | null>(null)
  const check = React.useCallback(() => {
    apiFetch<{ authenticated: boolean; mode: string; reason: string | null }>('/auth/session')
      .then(setAuth)
      .catch((e: Error) => setAuth({ authenticated: false, mode: 'password', reason: e.message }))
  }, [])
  React.useEffect(() => {
    check()
    setUnauthorizedHandler(() => setAuth((a) => (a ? { ...a, authenticated: false } : a)))
  }, [check])
  if (!auth)
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  if (!auth.authenticated) return <Login mode={auth.mode} reason={auth.reason} onDone={check} />
  return (
    <TooltipProvider>
      <LiveProvider>
        <Shell />
      </LiveProvider>
    </TooltipProvider>
  )
}
