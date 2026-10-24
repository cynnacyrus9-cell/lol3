import * as React from 'react'
import { AlertTriangle, FlaskConical } from 'lucide-react'
import { LiveProvider, useLive } from '@/state/live'
import { Header, TABS, type Page } from '@/components/layout/Header'
import { SaleToasts } from '@/components/SaleToasts'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Overview } from '@/pages/Overview'
import { Visits } from '@/pages/Visits'
import { LiveFeed } from '@/pages/LiveFeed'
import { TopSpenders } from '@/pages/TopSpenders'
import { Products } from '@/pages/Products'
import { Hourly } from '@/pages/Hourly'
import { Revenue } from '@/pages/Revenue'
import { DataSources } from '@/pages/DataSources'
import { Admin } from '@/pages/Admin'
import { Login } from '@/pages/Login'
import { apiFetch, setUnauthorizedHandler } from '@/lib/api'

const PAGES: Page[] = ['overview', 'feed', 'visits', 'spenders', 'products', 'hourly', 'daily', 'sources', 'admin']
const TITLES: Record<Page, string> = {
  ...(Object.fromEntries(TABS.map((t) => [t.id, t.label])) as Record<Page, string>),
  sources: 'Data sources',
  admin: 'Settings',
}

function pageFromHash(): Page {
  const h = location.hash.replace(/^#\/?/, '') as Page
  return PAGES.includes(h) ? h : 'visits'
}

function Shell() {
  const { live, bootError, reload } = useLive()
  const [page, setPage] = React.useState<Page>(pageFromHash)
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
    <div className="min-h-screen">
      <Header page={page} onNavigate={navigate} />
      <main className="mx-auto max-w-[1200px] px-3 py-3 sm:px-5 sm:py-4">
        {page === 'sources' || page === 'admin' ? <h2 className="mb-3 text-lg font-semibold tracking-tight">{TITLES[page]}</h2> : null}
        {live?.mode === 'development' ? (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2 text-[12.5px] text-warning" role="alert">
            <FlaskConical className="size-4 shrink-0" />
            <span>
              <b>Development mode.</b> Statistics include explicitly labelled synthetic test events.
            </span>
          </div>
        ) : null}
        {live && live.budget.level !== 'ok' ? (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2 text-[12.5px] text-warning" role="alert">
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
            {page === 'visits' && <Visits onOpenSettings={() => navigate('admin')} />}
            {page === 'overview' && <Overview />}
            {page === 'feed' && <LiveFeed />}
            {page === 'spenders' && <TopSpenders />}
            {page === 'products' && <Products />}
            {page === 'hourly' && <Hourly />}
            {page === 'daily' && <Revenue defaultRange={{ preset: '30d' }} showProducts={false} />}
            {page === 'sources' && <DataSources />}
            {page === 'admin' && <Admin />}
          </>
        )}
      </main>
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
