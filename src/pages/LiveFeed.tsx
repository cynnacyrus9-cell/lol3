import { Activity } from '@/pages/Activity'
import { ServersCard } from '@/components/ServersCard'

export function LiveFeed() {
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-5">
      <div className="xl:col-span-3">
        <Activity />
      </div>
      <div className="xl:col-span-2">
        <ServersCard />
      </div>
    </div>
  )
}
