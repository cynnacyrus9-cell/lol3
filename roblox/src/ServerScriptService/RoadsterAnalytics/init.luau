-- RoadsterAnalytics (ModuleScript in ServerScriptService)
--
-- Reports real-time player and purchase events from Roadster Life game servers
-- to the Roadster Life Analytics backend (Cloudflare Worker).
--
-- Guarantees:
--   * Never assigns MarketplaceService.ProcessReceipt. You keep your own handler
--     and wrap it (see WrapProcessReceipt) or call ReportDeveloperProductPurchase.
--   * Never yields, delays or changes the result of your receipt handler.
--   * Only reports developer products after your handler returned PurchaseGranted.
--   * Only reports game passes after Roblox reports wasPurchased = true AND
--     UserOwnsGamePassAsync confirms ownership. Prompts are never counted.
--   * All HTTP work runs in background threads inside pcall: an outage of the
--     analytics backend cannot break purchases, grants or the server.

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local MarketplaceService = game:GetService("MarketplaceService")
local RunService = game:GetService("RunService")
local DataStoreService = game:GetService("DataStoreService")

local Config = require(script:WaitForChild("Config"))
local Sha256 = require(script:WaitForChild("Sha256"))

local Analytics = {}
Analytics.Version = "1.0.0"

local PAYLOAD_VERSION = 1
local MAX_QUEUE = 1000
local MAX_BATCH_EVENTS = 150
local LOOP_INTERVAL = 0.2
local OUTBOX_EVERY_MS = 5 * 60 * 1000
local OUTBOX_AFTER_FAILURES = 3

local state = {
	started = false,
	closing = false,
	sending = false,
	queue = {},
	urgent = false,
	joins = {}, -- [userId] = { j = joinedAtMs, n = name }
	heartbeatSec = 60,
	flushSec = 1,
	lastSendAt = 0,
	nextAttemptAt = 0,
	failures = 0,
	jobId = "",
	startedAt = 0,
	productInfo = {},
	reportedReceipts = {},
	reportedReceiptCount = 0,
	reportedPasses = {},
	outboxed = {},
	pendingPurchases = {}, -- outbox keys of purchases queued or in flight on this server
	lastWarn = {},
	stats = { batches = 0, events = 0, failures = 0, dropped = 0, outboxed = 0, lastStatus = nil },
}

local function nowMs(): number
	return DateTime.now().UnixTimestampMillis
end

local function log(...)
	if Config.Debug then
		print("[RoadsterAnalytics]", ...)
	end
end

local function warnOnce(key: string, message: string)
	local t = nowMs()
	if (state.lastWarn[key] or -math.huge) + 60000 < t then
		state.lastWarn[key] = t
		warn("[RoadsterAnalytics] " .. message)
	end
end

local function clamp(value: any, lo: number, hi: number, fallback: number): number
	local n = tonumber(value)
	if n == nil then
		return fallback
	end
	return math.clamp(n, lo, hi)
end

local function enumName(value: any): string?
	if value == nil then
		return nil
	end
	if type(value) == "string" then
		return value
	end
	local ok, name = pcall(function()
		return value.Name
	end)
	return if ok and type(name) == "string" then name else nil
end

local function outboxKey(event: any): string
	if event.kind == "developer_product" then
		return "dp_" .. tostring(event.purchaseId)
	end
	return "gp_" .. tostring(event.u) .. "_" .. tostring(event.productId)
end

-- ---------------------------------------------------------------------------
-- Queue
-- ---------------------------------------------------------------------------

local function enqueue(event: { [string]: any }, urgent: boolean)
	if event.type == "purchase" then
		state.pendingPurchases[outboxKey(event)] = true
	end
	if #state.queue >= MAX_QUEUE then
		-- Keep purchases; drop the oldest join/leave instead (heartbeats reconcile them).
		for i, e in ipairs(state.queue) do
			if e.type ~= "purchase" then
				table.remove(state.queue, i)
				state.stats.dropped += 1
				break
			end
		end
	end
	table.insert(state.queue, event)
	if urgent then
		state.urgent = true
	end
end

local function takeBatch(): { any }
	local n = math.min(#state.queue, MAX_BATCH_EVENTS)
	local events = table.move(state.queue, 1, n, 1, {})
	state.queue = table.move(state.queue, n + 1, #state.queue, 1, {})
	return events
end

local function requeueFront(events: { any })
	local merged = table.move(events, 1, #events, 1, {})
	table.move(state.queue, 1, #state.queue, #merged + 1, merged)
	state.queue = merged
end

local function roster(): { any }
	local list = {}
	for userId, p in pairs(state.joins) do
		table.insert(list, { u = userId, j = p.j, n = p.n })
	end
	return list
end

-- ---------------------------------------------------------------------------
-- HTTP
-- ---------------------------------------------------------------------------

local function serverInfo()
	return {
		jobId = state.jobId,
		universeId = game.GameId,
		placeId = game.PlaceId,
		placeVersion = game.PlaceVersion,
		privateServer = game.PrivateServerId ~= "",
		studio = RunService:IsStudio(),
		startedAt = state.startedAt,
	}
end

local function buildHeaders(body: string): ({ [string]: any }?, string?)
	local headers: { [string]: any } = { ["Content-Type"] = "application/json" }
	local signing = Config.SigningSecret
	if type(signing) == "string" and #signing > 0 then
		if #signing < 24 then
			return nil, "Config.SigningSecret must be at least 24 characters"
		end
		local ts = string.format("%d", nowMs())
		headers["X-RL-Timestamp"] = ts
		headers["X-RL-Signature"] = "v1=" .. Sha256.hmacHex(signing, ts .. "." .. body)
		return headers, nil
	end
	local ok, secret = pcall(function()
		return HttpService:GetSecret(Config.SecretName)
	end)
	if not ok or secret == nil then
		return nil,
			`Secret "{tostring(Config.SecretName)}" is unavailable ({tostring(secret)}). Add it in Creator Hub → Secrets (Studio: Game Settings → Security).`
	end
	headers["Authorization"] = secret:AddPrefix("Bearer ")
	return headers, nil
end

-- Returns (statusCode or nil, decodedBody or errorMessage)
local function post(events: { any }, includeRoster: boolean): (number?, any)
	local payload = {
		v = PAYLOAD_VERSION,
		batchId = HttpService:GenerateGUID(false),
		sentAt = nowMs(),
		server = serverInfo(),
		players = if includeRoster then roster() else nil,
		events = events,
	}
	local okEncode, body = pcall(function()
		return HttpService:JSONEncode(payload)
	end)
	if not okEncode then
		return nil, "could not encode payload: " .. tostring(body)
	end
	local headers, headerError = buildHeaders(body)
	if not headers then
		return nil, headerError
	end
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = Config.Endpoint,
			Method = "POST",
			Headers = headers,
			Body = body,
		})
	end)
	if not ok then
		return nil, tostring(response)
	end
	local decoded = nil
	pcall(function()
		decoded = HttpService:JSONDecode(response.Body)
	end)
	return response.StatusCode, decoded
end

local function applyServerHints(data: any)
	if type(data) ~= "table" then
		return
	end
	state.heartbeatSec = clamp(data.heartbeatSec, 15, 600, state.heartbeatSec)
	state.flushSec = clamp(data.flushSec, 0.5, 60, state.flushSec)
end

-- ---------------------------------------------------------------------------
-- Product information (names / list prices), cached per server
-- ---------------------------------------------------------------------------

local function getProductInfo(id: number, infoType: any, attempts: number?): { [string]: any }?
	local key = tostring(enumName(infoType)) .. ":" .. tostring(id)
	local cached = state.productInfo[key]
	if cached then
		return cached
	end
	for attempt = 1, attempts or 3 do
		local ok, info = pcall(function()
			return MarketplaceService:GetProductInfoAsync(id, infoType)
		end)
		if not ok then
			ok, info = pcall(function()
				return MarketplaceService:GetProductInfo(id, infoType)
			end)
		end
		if ok and type(info) == "table" then
			state.productInfo[key] = info
			return info
		end
		if attempt < (attempts or 3) then
			task.wait(attempt)
		end
	end
	return nil
end

local function resolveCatalog(requests: any)
	if type(requests) ~= "table" then
		return
	end
	for _, r in ipairs(requests) do
		local kind = r.kind
		local id = tonumber(r.productId)
		if id and (kind == "developer_product" or kind == "game_pass") then
			local info = getProductInfo(id, if kind == "game_pass" then Enum.InfoType.GamePass else Enum.InfoType.Product, 2)
			if info then
				enqueue({
					type = "catalog",
					kind = kind,
					productId = id,
					name = if type(info.Name) == "string" then info.Name else nil,
					price = tonumber(info.PriceInRobux),
				}, false)
			end
		end
	end
end

-- ---------------------------------------------------------------------------
-- Outbox (undelivered purchases survive server shutdowns and outages)
-- ---------------------------------------------------------------------------

local outboxStore: any = nil
local function getOutbox(): any
	if outboxStore == nil then
		local ok, store = pcall(function()
			return DataStoreService:GetDataStore(Config.OutboxDataStore)
		end)
		outboxStore = if ok and store then store else false
	end
	return if outboxStore then outboxStore else nil
end

local function saveToOutbox(event: any)
	local key = outboxKey(event)
	if state.outboxed[key] then
		return
	end
	local store = getOutbox()
	if not store then
		return
	end
	local ok, err = pcall(function()
		store:SetAsync(key, event)
	end)
	if ok then
		state.outboxed[key] = true
		state.stats.outboxed += 1
	else
		warnOnce("outbox", "Could not save an undelivered purchase to the outbox: " .. tostring(err))
	end
end

-- A purchase that was outboxed and later delivered normally no longer needs
-- the outbox copy (the backend would ignore the duplicate, but it costs a request).
local function clearDelivered(events: { any })
	local store = nil
	for _, e in ipairs(events) do
		if e.type == "purchase" then
			local key = outboxKey(e)
			state.pendingPurchases[key] = nil
			if state.outboxed[key] then
				store = store or getOutbox()
				if store then
					local ok = pcall(function()
						store:RemoveAsync(key)
					end)
					if ok then
						state.outboxed[key] = nil
					end
				end
			end
		end
	end
end

local function outboxPurchases(events: { any })
	for _, e in ipairs(events) do
		if e.type == "purchase" then
			saveToOutbox(e)
		end
	end
end

local function drainOutbox()
	local store = getOutbox()
	if not store then
		return
	end
	local ok, pages = pcall(function()
		return store:ListKeysAsync(nil, 25)
	end)
	if not ok or not pages then
		return
	end
	local okPage, page = pcall(function()
		return pages:GetCurrentPage()
	end)
	if not okPage or type(page) ~= "table" then
		return
	end
	for _, info in ipairs(page) do
		local key = info.KeyName
		if state.pendingPurchases[key] then
			continue -- still being retried by this server's queue
		end
		local okGet, event = pcall(function()
			return store:GetAsync(key)
		end)
		if okGet and type(event) == "table" then
			-- One purchase per request so a single invalid entry cannot block others.
			local status = post({ event }, false)
			-- 200: delivered (or already recorded — the backend is idempotent).
			-- 400: permanently invalid (e.g. older than 30 days).
			if status == 200 or status == 400 then
				pcall(function()
					store:RemoveAsync(key)
				end)
				state.outboxed[key] = nil
			end
		elseif okGet and event == nil then
			state.outboxed[key] = nil
		end
	end
end

-- ---------------------------------------------------------------------------
-- Flushing
-- ---------------------------------------------------------------------------

local function backoffMs(failures: number): number
	return math.min(2 ^ failures, 60) * 1000
end

local function flushOnce()
	if state.sending then
		return
	end
	state.sending = true
	local events = takeBatch()
	local status, data = post(events, true)
	state.lastSendAt = nowMs()
	state.stats.lastStatus = status
	if status == 200 then
		state.failures = 0
		state.stats.batches += 1
		state.stats.events += #events
		applyServerHints(data)
		task.spawn(clearDelivered, events)
		if type(data) == "table" and data.catalogRequest then
			task.spawn(resolveCatalog, data.catalogRequest)
		end
	elseif status == 429 then
		requeueFront(events)
		state.nextAttemptAt = nowMs() + 10000
		applyServerHints(data)
	elseif status ~= nil and status >= 400 and status < 500 then
		-- Configuration problem (secret, universe, validation). Retrying will not
		-- help: keep purchases in the outbox and drop the rest (heartbeats will
		-- re-sync the roster once fixed).
		state.failures += 1
		state.stats.failures += 1
		outboxPurchases(events)
		for _, e in ipairs(events) do
			if e.type == "purchase" then
				state.pendingPurchases[outboxKey(e)] = nil
			end
		end
		local message = if type(data) == "table" and data.error then tostring(data.error) else ""
		warnOnce("http" .. tostring(status), `Backend rejected events ({status}) {message}`)
		state.nextAttemptAt = nowMs() + backoffMs(state.failures)
	else
		-- Network error or 5xx: retry with backoff, nothing is lost.
		state.failures += 1
		state.stats.failures += 1
		requeueFront(events)
		if state.failures >= OUTBOX_AFTER_FAILURES then
			outboxPurchases(events)
		end
		warnOnce("network", "Analytics backend unreachable: " .. tostring(data))
		state.nextAttemptAt = nowMs() + backoffMs(state.failures)
	end
	state.sending = false
end

local function loop()
	while not state.closing do
		local t = nowMs()
		if t >= state.nextAttemptAt then
			local heartbeatDue = t - state.lastSendAt >= state.heartbeatSec * 1000
			local flushDue = #state.queue > 0 and (state.urgent or t - state.lastSendAt >= state.flushSec * 1000)
			if heartbeatDue or flushDue then
				state.urgent = false
				local ok, err = pcall(flushOnce)
				if not ok then
					state.sending = false
					warnOnce("flush", "Unexpected error while sending: " .. tostring(err))
				end
			end
		end
		task.wait(LOOP_INTERVAL)
	end
end

local function outboxLoop()
	task.wait(30)
	while not state.closing do
		pcall(drainOutbox)
		task.wait(OUTBOX_EVERY_MS / 1000)
	end
end

-- ---------------------------------------------------------------------------
-- Players
-- ---------------------------------------------------------------------------

local function onJoin(player: Player)
	local userId = player.UserId
	-- Studio "local server" test clients have negative user IDs; they are not real players.
	if userId <= 0 or state.joins[userId] then
		return
	end
	local j = nowMs()
	local name = if Config.IncludeUsernames then player.Name else nil
	state.joins[userId] = { j = j, n = name }
	enqueue({ type = "join", u = userId, j = j, n = name }, false)
end

local function onLeave(player: Player)
	local userId = player.UserId
	local p = state.joins[userId]
	if not p then
		return
	end
	state.joins[userId] = nil
	enqueue({ type = "leave", u = userId, j = p.j, at = nowMs() }, false)
end

-- ---------------------------------------------------------------------------
-- Purchases
-- ---------------------------------------------------------------------------

--[[
	Reports a developer product purchase. Call this ONLY after the item has been
	granted, i.e. right before your ProcessReceipt handler returns
	Enum.ProductPurchaseDecision.PurchaseGranted. It never yields the caller.
]]
function Analytics.ReportDeveloperProductPurchase(receiptInfo: { [string]: any })
	if type(receiptInfo) ~= "table" or receiptInfo.PurchaseId == nil or receiptInfo.PlayerId == nil then
		return
	end
	local purchaseId = tostring(receiptInfo.PurchaseId)
	if state.reportedReceipts[purchaseId] then
		return -- the backend also deduplicates by PurchaseId
	end
	state.reportedReceipts[purchaseId] = true
	state.reportedReceiptCount += 1
	if state.reportedReceiptCount > 5000 then
		state.reportedReceipts = { [purchaseId] = true }
		state.reportedReceiptCount = 1
	end

	task.spawn(function()
		local ok, err = pcall(function()
			local userId = tonumber(receiptInfo.PlayerId)
			local productId = tonumber(receiptInfo.ProductId)
			if not userId or userId <= 0 or not productId then
				return
			end
			local currency = enumName(receiptInfo.CurrencyType)
			local spent = tonumber(receiptInfo.CurrencySpent)
			if spent == nil then
				warnOnce("nospent", "Receipt without CurrencySpent; purchase not reported")
				return
			end
			local player = Players:GetPlayerByUserId(userId)
			-- One quick lookup for a friendly name; the dashboard also has its own catalog.
			local info = getProductInfo(productId, Enum.InfoType.Product, 1)
			enqueue({
				type = "purchase",
				kind = "developer_product",
				purchaseId = purchaseId,
				productId = productId,
				robux = math.max(0, math.floor(spent)),
				u = userId,
				at = nowMs(),
				productName = if info and type(info.Name) == "string" then info.Name else nil,
				n = if Config.IncludeUsernames and player then player.Name else nil,
				placeIdWherePurchased = tonumber(receiptInfo.PlaceIdWherePurchased),
				currencyType = currency,
			}, true)
		end)
		if not ok then
			warnOnce("receipt", "Could not queue purchase report: " .. tostring(err))
		end
	end)
end

--[[
	Wraps YOUR existing ProcessReceipt handler. Your handler runs exactly as
	before (same arguments, same errors, same return value). If it returns
	PurchaseGranted, the purchase is reported in the background.

	Usage — change only the line where you assign the callback:
		MarketplaceService.ProcessReceipt = Analytics.WrapProcessReceipt(processReceipt)
]]
function Analytics.WrapProcessReceipt(handler: (receiptInfo: any) -> any): (receiptInfo: any) -> any
	assert(type(handler) == "function", "WrapProcessReceipt expects your ProcessReceipt function")
	return function(receiptInfo)
		local decision = handler(receiptInfo)
		if decision == Enum.ProductPurchaseDecision.PurchaseGranted then
			pcall(Analytics.ReportDeveloperProductPurchase, receiptInfo)
		end
		return decision
	end
end

local function reportVerifiedGamePass(player: Player, gamePassId: number)
	local key = tostring(player.UserId) .. ":" .. tostring(gamePassId)
	if state.reportedPasses[key] then
		return
	end
	local info = getProductInfo(gamePassId, Enum.InfoType.GamePass, 3)
	local price = info and tonumber(info.PriceInRobux)
	if price == nil then
		-- No verified price: do not invent an amount.
		warnOnce("gpprice", "Game pass price unavailable; purchase of " .. tostring(gamePassId) .. " not reported")
		return
	end
	state.reportedPasses[key] = true
	enqueue({
		type = "purchase",
		kind = "game_pass",
		productId = gamePassId,
		robux = math.max(0, math.floor(price)),
		u = player.UserId,
		at = nowMs(),
		productName = if type(info.Name) == "string" then info.Name else nil,
		n = if Config.IncludeUsernames then player.Name else nil,
	}, true)
end

--[[
	Reports a game pass purchase after verifying ownership with
	UserOwnsGamePassAsync. The module already does this automatically for
	in-experience prompts when Config.TrackGamePasses is true; call it yourself
	only if you disabled that option. Never yields the caller.
]]
function Analytics.ReportGamePassPurchase(player: Player, gamePassId: number)
	task.spawn(function()
		local ok, err = pcall(function()
			if player.UserId <= 0 then
				return
			end
			for attempt = 1, 4 do
				local okOwns, owns = pcall(function()
					return MarketplaceService:UserOwnsGamePassAsync(player.UserId, gamePassId)
				end)
				if okOwns and owns == true then
					reportVerifiedGamePass(player, gamePassId)
					return
				end
				task.wait(attempt * 2)
			end
			warnOnce("gpverify", "Could not verify game pass ownership; purchase not reported")
		end)
		if not ok then
			warnOnce("gp", "Game pass report failed: " .. tostring(err))
		end
	end)
end

local function onGamePassPromptFinished(player: Player, gamePassId: number, wasPurchased: boolean)
	-- Closing or cancelling the prompt is not a sale.
	if wasPurchased ~= true then
		return
	end
	Analytics.ReportGamePassPurchase(player, gamePassId)
end

-- ---------------------------------------------------------------------------
-- Lifecycle
-- ---------------------------------------------------------------------------

local function onClose()
	state.closing = true
	enqueue({ type = "server_close", at = nowMs() }, true)
	local deadline = nowMs() + 20000
	while #state.queue > 0 and nowMs() < deadline do
		local events = takeBatch()
		local status = post(events, false)
		if status ~= 200 then
			outboxPurchases(events)
			if status == nil or status >= 500 or status == 429 then
				task.wait(1)
				requeueFront(events)
			end
		end
	end
	if #state.queue > 0 then
		outboxPurchases(state.queue)
	end
end

function Analytics.Start(overrides: { [string]: any }?)
	if state.started then
		return Analytics
	end
	if overrides then
		for k, v in pairs(overrides) do
			Config[k] = v
		end
	end
	if not Config.Enabled then
		log("disabled in Config")
		return Analytics
	end
	if RunService:IsStudio() and not Config.EnableInStudio then
		log("disabled in Studio")
		return Analytics
	end
	if type(Config.Endpoint) ~= "string" or not string.match(Config.Endpoint, "^https://") or string.find(Config.Endpoint, "REPLACE-ME", 1, true) then
		warn("[RoadsterAnalytics] Set Config.Endpoint to your Worker URL ending in /ingest. Analytics is not running.")
		return Analytics
	end
	state.started = true
	state.jobId = if game.JobId ~= "" then game.JobId else "studio-" .. HttpService:GenerateGUID(false)
	state.startedAt = nowMs()

	Players.PlayerAdded:Connect(onJoin)
	Players.PlayerRemoving:Connect(onLeave)
	for _, player in ipairs(Players:GetPlayers()) do
		onJoin(player)
	end
	if Config.TrackGamePasses then
		MarketplaceService.PromptGamePassPurchaseFinished:Connect(onGamePassPromptFinished)
	end
	game:BindToClose(function()
		local ok, err = pcall(onClose)
		if not ok then
			warn("[RoadsterAnalytics] shutdown flush failed: " .. tostring(err))
		end
	end)
	task.spawn(loop)
	task.spawn(outboxLoop)
	log("started", state.jobId)
	return Analytics
end

function Analytics.GetStats()
	return {
		started = state.started,
		queued = #state.queue,
		heartbeatSec = state.heartbeatSec,
		flushSec = state.flushSec,
		failures = state.failures,
		batches = state.stats.batches,
		events = state.stats.events,
		dropped = state.stats.dropped,
		outboxed = state.stats.outboxed,
		lastStatus = state.stats.lastStatus,
	}
end

return Analytics
