-- Behavioural tests for the RoadsterAnalytics module (run by roblox/tests/run.mjs).
local Analytics = __MODULES.RoadsterAnalytics
local Sha256 = __MODULES.Sha256

local function check(cond, message)
	if not cond then
		error(message or "check failed", 2)
	end
end

local function eq(actual, expected, message)
	if actual ~= expected then
		error(string.format("%s: expected %s, got %s", message or "eq", tostring(expected), tostring(actual)), 2)
	end
end

local function decoded()
	local out = {}
	for _, r in ipairs(__requests) do
		local body = __JSON.decode(r.Body)
		body.__status = r.StatusCode
		body.__headers = r.Headers
		table.insert(out, body)
	end
	return out
end

local function events(filter, onlyDelivered)
	local out = {}
	for _, b in ipairs(decoded()) do
		if not onlyDelivered or b.__status == 200 then
			for _, e in ipairs(b.events or {}) do
				if filter == nil or e.type == filter then
					table.insert(out, e)
				end
			end
		end
	end
	return out
end

local function receipt(purchaseId, overrides)
	local r = {
		PurchaseId = purchaseId,
		PlayerId = 1001,
		ProductId = 555,
		CurrencySpent = 249,
		CurrencyType = Enum.CurrencyType.Robux,
		PlaceIdWherePurchased = 111,
	}
	for k, v in pairs(overrides or {}) do
		r[k] = v
	end
	return r
end

local function respond(status, body)
	__httpHandler = function()
		return { StatusCode = status, Body = body or '{"ok":true,"heartbeatSec":60,"flushSec":1}' }
	end
end

local function noErrors()
	eq(#__errors, 0, "thread errors: " .. table.concat(__errors, " | "))
end

MarketplaceMock.__info["Product:555"] = { Name = "Nitro Boost", PriceInRobux = 249 }
MarketplaceMock.__info["GamePass:777"] = { Name = "VIP Garage", PriceInRobux = 399 }
MarketplaceMock.__info["GamePass:778"] = { Name = "Drift Kit", PriceInRobux = 149 }

local function start(overrides)
	local o = { Endpoint = "https://analytics.example.workers.dev/ingest" }
	for k, v in pairs(overrides or {}) do
		o[k] = v
	end
	Analytics.Start(o)
end

TESTS = {}

TESTS["reports joins and leaves within about a second"] = function()
	start()
	__advance(500)
	local before = #__requests
	__addPlayer(1001, "Racer")
	__advance(1300)
	check(#__requests > before, "a request should be sent after the join")
	local joins = events("join", true)
	eq(#joins, 1, "join events")
	eq(joins[1].u, 1001, "join user")
	eq(joins[1].n, "Racer", "username")
	__removePlayer(1001)
	__advance(1300)
	local leaves = events("leave", true)
	eq(#leaves, 1, "leave events")
	eq(leaves[1].j, joins[1].j, "leave references the join time")
	noErrors()
end

TESTS["sends heartbeats with the full player roster"] = function()
	start()
	__addPlayer(1001)
	__addPlayer(1002)
	__advance(2000)
	local n = #__requests
	__advance(61000)
	check(#__requests > n, "heartbeat expected")
	local last = decoded()[#__requests]
	eq(#last.players, 2, "roster size")
	eq(#(last.events or {}), 0, "heartbeat has no events")
	eq(last.server.jobId, game.JobId, "job id")
	eq(last.server.universeId, 4242, "universe id")
	noErrors()
end

TESTS["follows heartbeat and batching hints from the backend"] = function()
	respond(200, '{"ok":true,"heartbeatSec":120,"flushSec":5}')
	start()
	__advance(1000)
	eq(Analytics.GetStats().heartbeatSec, 120, "heartbeat hint")
	eq(Analytics.GetStats().flushSec, 5, "flush hint")
	local n = #__requests
	__advance(90000)
	eq(#__requests, n, "no heartbeat before 120 s")
	__advance(40000)
	check(#__requests > n, "heartbeat after 120 s")
end

TESTS["wrapped ProcessReceipt returns the same decision without yielding"] = function()
	start()
	__addPlayer(1001)
	local calls = 0
	local wrapped = Analytics.WrapProcessReceipt(function(info)
		calls += 1
		eq(info.PurchaseId, "receipt-1", "handler receives the receipt")
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end)
	-- Called on a thread that must not yield: the mock errors if anything waits.
	local decision = wrapped(receipt("receipt-1"))
	eq(decision, Enum.ProductPurchaseDecision.PurchaseGranted, "decision passes through")
	eq(calls, 1, "handler called once")
	__advance(1500)
	local purchases = events("purchase", true)
	eq(#purchases, 1, "purchase reported")
	local p = purchases[1]
	eq(p.kind, "developer_product", "kind")
	eq(p.purchaseId, "receipt-1", "PurchaseId")
	eq(p.robux, 249, "CurrencySpent")
	eq(p.productName, "Nitro Boost", "product name")
	eq(p.currencyType, "Robux", "currency")
	noErrors()
end

TESTS["does not report receipts that were not granted"] = function()
	start()
	local wrapped = Analytics.WrapProcessReceipt(function()
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end)
	eq(wrapped(receipt("receipt-2")), Enum.ProductPurchaseDecision.NotProcessedYet, "decision passes through")
	__advance(3000)
	eq(#events("purchase"), 0, "no purchase for NotProcessedYet")
end

TESTS["handler errors propagate unchanged and nothing is reported"] = function()
	start()
	local wrapped = Analytics.WrapProcessReceipt(function()
		error("grant failed")
	end)
	local ok, err = pcall(wrapped, receipt("receipt-3"))
	eq(ok, false, "error propagates so Roblox retries the receipt")
	check(string.find(tostring(err), "grant failed", 1, true) ~= nil, "original error message")
	__advance(3000)
	eq(#events("purchase"), 0, "nothing reported")
end

TESTS["a repeated receipt is only reported once by the module"] = function()
	start()
	local wrapped = Analytics.WrapProcessReceipt(function()
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end)
	wrapped(receipt("receipt-4"))
	wrapped(receipt("receipt-4"))
	__advance(2000)
	eq(#events("purchase"), 1, "single report")
end

TESTS["backend outage never blocks grants and purchases are retried until delivered"] = function()
	local attempts = 0
	__httpHandler = function()
		attempts += 1
		if attempts <= 4 then
			return { StatusCode = 503, Body = "unavailable" }
		end
		return { StatusCode = 200, Body = '{"ok":true,"heartbeatSec":60,"flushSec":1}' }
	end
	start()
	local wrapped = Analytics.WrapProcessReceipt(function()
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end)
	eq(wrapped(receipt("receipt-5")), Enum.ProductPurchaseDecision.PurchaseGranted, "grant unaffected")
	__advance(10000)
	eq(#events("purchase", true), 0, "not delivered during the outage")
	-- After repeated failures the purchase is persisted so a restart cannot lose it.
	local store = DataStoreServiceMock:GetDataStore("RoadsterAnalyticsOutbox_v1")
	check(store.data["dp_receipt-5"] ~= nil, "outbox copy after repeated failures")
	__advance(60000)
	local delivered = events("purchase", true)
	eq(#delivered, 1, "delivered exactly once after retries")
	eq(delivered[1].purchaseId, "receipt-5", "same purchase")
	eq(store.data["dp_receipt-5"], nil, "outbox copy removed after delivery")
	noErrors()
end

TESTS["rejected batches keep purchases in the outbox and resend them later"] = function()
	respond(401, '{"ok":false,"error":"Invalid credentials"}')
	start()
	local wrapped = Analytics.WrapProcessReceipt(function()
		return Enum.ProductPurchaseDecision.PurchaseGranted
	end)
	wrapped(receipt("receipt-6"))
	__advance(3000)
	local store = DataStoreServiceMock:GetDataStore("RoadsterAnalyticsOutbox_v1")
	check(store.data["dp_receipt-6"] ~= nil, "saved to outbox")
	check(#table.concat(__logs, "\n") > 0, "a warning was logged")
	respond(200)
	__advance(6 * 60 * 1000, 500)
	eq(store.data["dp_receipt-6"], nil, "removed after delivery")
	local delivered = events("purchase", true)
	check(#delivered >= 1, "delivered from outbox")
	noErrors()
end

TESTS["game passes: cancelled prompts are ignored, verified purchases use the list price"] = function()
	start()
	local player = __addPlayer(1001, "Racer")
	MarketplaceMock.PromptGamePassPurchaseFinished:Fire(player, 777, false)
	__advance(3000)
	eq(#events("purchase"), 0, "cancelled prompt not counted")
	MarketplaceMock.__owns["1001:777"] = true
	MarketplaceMock.PromptGamePassPurchaseFinished:Fire(player, 777, true)
	__advance(3000)
	local p = events("purchase", true)
	eq(#p, 1, "verified purchase reported")
	eq(p[1].kind, "game_pass", "kind")
	eq(p[1].robux, 399, "list price")
	eq(p[1].productId, 777, "pass id")
	-- Roblox says purchased, but ownership cannot be verified: do not report.
	MarketplaceMock.PromptGamePassPurchaseFinished:Fire(player, 778, true)
	__advance(30000)
	eq(#events("purchase", true), 1, "unverified purchase not reported")
	noErrors()
end

TESTS["uses the Secrets store as a bearer token"] = function()
	start()
	__addPlayer(1001)
	__advance(1500)
	local r = __requests[1]
	eq(r.Headers.Authorization, "Bearer test-ingest-secret-0123456789abcdef", "bearer header")
	eq(r.Headers["X-RL-Signature"], nil, "no signature in bearer mode")
	eq(r.Url, "https://analytics.example.workers.dev/ingest", "endpoint")
end

TESTS["signs requests with HMAC when a signing secret is configured"] = function()
	start({ SigningSecret = "hmac-secret-abcdefghijklmnopqrstuvwxyz" })
	__addPlayer(1001)
	__advance(1500)
	local r = __requests[1]
	eq(r.Headers.Authorization, nil, "no bearer in HMAC mode")
	return { body = r.Body, ts = r.Headers["X-RL-Timestamp"], sig = r.Headers["X-RL-Signature"] }
end

TESTS["a missing secret logs a warning and never crashes"] = function()
	__secrets = {}
	start()
	__addPlayer(1001)
	__advance(5000)
	eq(#__requests, 0, "nothing sent without credentials")
	check(string.find(table.concat(__logs, "\n"), "Secret", 1, true) ~= nil, "warning mentions the secret")
	noErrors()
end

TESTS["does not start until the endpoint is configured"] = function()
	Analytics.Start({ Endpoint = "https://REPLACE-ME.workers.dev/ingest" })
	__addPlayer(1001)
	__advance(5000)
	eq(#__requests, 0, "not started")
	eq(Analytics.GetStats().started, false, "stats")
end

TESTS["ignores Studio test clients with negative user ids and flags Studio servers"] = function()
	__studio = true -- game.JobId = "" is applied before the module loads (see run.mjs)
	start()
	__addPlayer(-1)
	__addPlayer(1001)
	__advance(1500)
	local joins = events("join")
	eq(#joins, 1, "only the real account")
	local body = decoded()[1]
	eq(body.server.studio, true, "studio flag")
	check(string.sub(body.server.jobId, 1, 7) == "studio-", "generated studio job id: " .. tostring(body.server.jobId))
end

TESTS["flushes a server_close event on shutdown"] = function()
	start()
	__addPlayer(1001)
	__advance(1500)
	__shutdown()
	__advance(2000)
	local closes = events("server_close", true)
	eq(#closes, 1, "server_close sent")
	noErrors()
end

TESTS["resolves product names requested by the backend"] = function()
	respond(200, '{"ok":true,"heartbeatSec":60,"flushSec":1,"catalogRequest":[{"kind":"game_pass","productId":777}]}')
	start()
	__advance(3000)
	local cat = events("catalog")
	check(#cat >= 1, "catalog event sent")
	eq(cat[1].name, "VIP Garage", "name")
	eq(cat[1].price, 399, "price")
end

TESTS["sha256 vectors"] = function()
	return {
		empty = Sha256.toHex(Sha256.digest("")),
		abc = Sha256.toHex(Sha256.digest("abc")),
		long = Sha256.toHex(Sha256.digest(string.rep("a", 1000))),
		block = Sha256.toHex(Sha256.digest(string.rep("x", 55))),
		block2 = Sha256.toHex(Sha256.digest(string.rep("y", 64))),
		hmacShort = Sha256.hmacHex("key", "The quick brown fox jumps over the lazy dog"),
		hmacLongKey = Sha256.hmacHex(string.rep("k", 100), "message"),
	}
end

return true
