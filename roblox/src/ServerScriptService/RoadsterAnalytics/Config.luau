-- Config (ModuleScript, child of RoadsterAnalytics)
-- Server-only settings for the Roadster Life Analytics integration.
-- This ModuleScript lives in ServerScriptService, which is never replicated to
-- players, but anyone with edit access to the place can read it. Keep the
-- ingest secret in the Roblox Secrets store instead of in this file.

return {
	-- Your deployed Worker URL followed by /ingest, for example:
	-- "https://roadster-life-analytics.your-subdomain.workers.dev/ingest"
	Endpoint = "https://REPLACE-ME.workers.dev/ingest",

	-- Recommended: name of a secret created in Creator Hub → your experience →
	-- Secrets (and, for Studio testing, Game Settings → Security → Secrets).
	-- Its value must equal the Worker's INGEST_SECRET, and its allowed domain must
	-- match the Worker hostname. Scripts can attach it to requests but can never
	-- read it.
	SecretName = "RoadsterAnalyticsIngest",

	-- Optional alternative: HMAC-sign every request with this string (must equal
	-- INGEST_SECRET). Use this only if you cannot use the Secrets store; leave nil
	-- otherwise. Required if the Worker sets INGEST_REQUIRE_HMAC = "true".
	SigningSecret = nil,

	Enabled = true,

	-- Studio play-tests are sent with studio = true. The dashboard stores them
	-- separately (Admin → Integration test) and never counts them as real data.
	EnableInStudio = true,

	-- Send Roblox usernames with joins and purchases for the activity feed.
	IncludeUsernames = true,

	-- Listen to MarketplaceService.PromptGamePassPurchaseFinished and report
	-- verified in-experience game pass purchases.
	TrackGamePasses = true,

	-- DataStore used to keep purchase reports that could not be delivered
	-- (e.g. backend outage) so another server can resend them later.
	OutboxDataStore = "RoadsterAnalyticsOutbox_v1",

	Debug = false,
}
