import * as React from 'react'
import { Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { apiPost } from '@/lib/api'

export function Login({ mode, reason, onDone }: { mode: string; reason: string | null; onDone: () => void }) {
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiPost('/auth/login', { password })
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9 rounded-lg" />
          <div>
            <h1 className="text-base font-semibold">Roadster Life Analytics</h1>
            <p className="text-xs text-muted">Private dashboard</p>
          </div>
        </div>
        {mode === 'access' ? (
          <div className="space-y-2 text-sm text-ink-2">
            <p className="flex items-center gap-2 font-medium text-ink">
              <Lock className="size-4" /> Protected by Cloudflare Access
            </p>
            <p>{reason ?? 'Sign in through your Cloudflare Access login page to continue.'}</p>
            <Button className="mt-2 w-full" onClick={() => location.reload()}>
              Retry
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="pw">Password</Label>
              <Input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </div>
            {error ? <p className="text-sm text-[#ff9b9b]">{error}</p> : null}
            {reason && !error && reason !== 'Not signed in' ? <p className="text-xs text-warning">{reason}</p> : null}
            <Button type="submit" className="w-full" disabled={busy || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        )}
      </Card>
    </div>
  )
}
