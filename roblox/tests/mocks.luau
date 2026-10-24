-- Minimal Roblox engine mocks for running the RoadsterAnalytics module under
-- plain Luau (luau-web). Time is virtual and advanced with __advance(ms).

__logs = {}
__errors = {}
__requests = {}
__httpLatency = 0.05
__httpHandler = function(_req)
	return { StatusCode = 200, Body = '{"ok":true,"accepted":0,"duplicates":0,"rejected":0,"heartbeatSec":60,"flushSec":1}' }
end
__secrets = { RoadsterAnalyticsIngest = "test-ingest-secret-0123456789abcdef" }
__studio = false
__MODULES = {}

warn = function(...)
	local parts = table.pack(...)
	for i = 1, parts.n do
		parts[i] = tostring(parts[i])
	end
	table.insert(__logs, "WARN " .. table.concat(parts, " "))
end

-- ---------------------------------------------------------------- scheduler
local threads = {}
local current = nil

local function resume(co, ...)
	local prev = current
	current = co
	local ok, err = coroutine.resume(co, ...)
	current = prev
	if not ok then
		table.insert(__errors, tostring(err))
	end
end

task = {}
function task.spawn(fn, ...)
	local co = if type(fn) == "thread" then fn else coroutine.create(fn)
	resume(co, ...)
	return co
end
function task.defer(fn, ...)
	local co = coroutine.create(fn)
	table.insert(threads, { co = co, wake = __now, args = table.pack(...) })
	return co
end
function task.delay(sec, fn, ...)
	local co = coroutine.create(fn)
	table.insert(threads, { co = co, wake = __now + (sec or 0) * 1000, args = table.pack(...) })
	return co
end
function task.wait(sec)
	local co = coroutine.running()
	if co == nil or co ~= current then
		-- In Roblox this would yield the calling thread (e.g. a ProcessReceipt handler).
		error("task.wait called on a thread that must not yield", 2)
	end
	sec = sec or 0
	table.insert(threads, { co = co, wake = __now + sec * 1000 })
	coroutine.yield()
	return sec
end

function __advance(ms, step)
	step = step or 50
	local target = __now + ms
	while true do
		local progressed = true
		while progressed do
			progressed = false
			for i, t in ipairs(threads) do
				if t.wake <= __now then
					table.remove(threads, i)
					if t.args then
						resume(t.co, table.unpack(t.args, 1, t.args.n))
					else
						resume(t.co)
					end
					progressed = true
					break
				end
			end
		end
		if __now >= target then
			break
		end
		__now = math.min(__now + step, target)
	end
end

DateTime = {
	now = function()
		return { UnixTimestampMillis = __now }
	end,
}

-- ---------------------------------------------------------------- signals
local function Signal()
	local s = { handlers = {} }
	function s:Connect(fn)
		table.insert(self.handlers, fn)
		return { Disconnect = function() end }
	end
	function s:Fire(...)
		for _, h in ipairs(self.handlers) do
			task.spawn(h, ...)
		end
	end
	return s
end

-- ---------------------------------------------------------------- JSON
local JSON = {}
local function encodeString(s)
	return '"' .. s:gsub('[%c"\\]', function(c)
		local map = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
		return map[c] or string.format("\\u%04x", string.byte(c))
	end) .. '"'
end
function JSON.encode(v)
	local t = type(v)
	if t == "nil" then
		return "null"
	elseif t == "boolean" then
		return tostring(v)
	elseif t == "number" then
		if v == math.floor(v) and math.abs(v) < 2 ^ 53 then
			return string.format("%d", v)
		end
		return string.format("%.14g", v)
	elseif t == "string" then
		return encodeString(v)
	elseif t == "table" then
		if next(v) == nil or #v > 0 then
			local parts = {}
			for _, x in ipairs(v) do
				table.insert(parts, JSON.encode(x))
			end
			return "[" .. table.concat(parts, ",") .. "]"
		end
		local parts = {}
		for k, x in pairs(v) do
			table.insert(parts, encodeString(tostring(k)) .. ":" .. JSON.encode(x))
		end
		table.sort(parts)
		return "{" .. table.concat(parts, ",") .. "}"
	end
	error("cannot encode " .. t)
end
function JSON.decode(s)
	local i = 1
	local function ws()
		i = string.find(s, "[^ \t\r\n]", i) or (#s + 1)
	end
	local value
	local function str()
		i += 1
		local out = {}
		while true do
			local c = string.sub(s, i, i)
			if c == "" then
				error("unterminated string")
			elseif c == '"' then
				i += 1
				return table.concat(out)
			elseif c == "\\" then
				local e = string.sub(s, i + 1, i + 1)
				local map = { n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
				if e == "u" then
					table.insert(out, utf8.char(tonumber(string.sub(s, i + 2, i + 5), 16)))
					i += 6
				else
					table.insert(out, map[e] or e)
					i += 2
				end
			else
				table.insert(out, c)
				i += 1
			end
		end
	end
	function value()
		ws()
		local c = string.sub(s, i, i)
		if c == "{" then
			i += 1
			local obj = {}
			ws()
			if string.sub(s, i, i) == "}" then
				i += 1
				return obj
			end
			while true do
				ws()
				local k = str()
				ws()
				if string.sub(s, i, i) ~= ":" then
					error("expected :")
				end
				i += 1
				obj[k] = value()
				ws()
				local d = string.sub(s, i, i)
				i += 1
				if d == "}" then
					return obj
				elseif d ~= "," then
					error("expected , or }")
				end
			end
		elseif c == "[" then
			i += 1
			local arr = {}
			ws()
			if string.sub(s, i, i) == "]" then
				i += 1
				return arr
			end
			while true do
				table.insert(arr, value())
				ws()
				local d = string.sub(s, i, i)
				i += 1
				if d == "]" then
					return arr
				elseif d ~= "," then
					error("expected , or ]")
				end
			end
		elseif c == '"' then
			return str()
		elseif string.sub(s, i, i + 3) == "true" then
			i += 4
			return true
		elseif string.sub(s, i, i + 4) == "false" then
			i += 5
			return false
		elseif string.sub(s, i, i + 3) == "null" then
			i += 4
			return nil
		else
			local num = string.match(s, "^-?%d+%.?%d*[eE]?[-+]?%d*", i)
			if not num then
				error("unexpected character at " .. i)
			end
			i += #num
			return tonumber(num)
		end
	end
	local v = value()
	return v
end
__JSON = JSON

-- ---------------------------------------------------------------- services
local function makeSecret(value)
	return {
		__secret = value,
		AddPrefix = function(self, prefix)
			return makeSecret(prefix .. self.__secret)
		end,
	}
end

local guid = 0
HttpServiceMock = {}
function HttpServiceMock:GenerateGUID(_braces)
	guid += 1
	return string.format("00000000-0000-4000-8000-%012d", guid)
end
function HttpServiceMock:JSONEncode(v)
	return JSON.encode(v)
end
function HttpServiceMock:JSONDecode(s)
	return JSON.decode(s)
end
function HttpServiceMock:GetSecret(name)
	local v = __secrets[name]
	if v == nil then
		error("Can't find secret with given key")
	end
	return makeSecret(v)
end
function HttpServiceMock:RequestAsync(req)
	local headers = {}
	for k, v in pairs(req.Headers or {}) do
		-- Roblox substitutes Secret values when the request is sent.
		headers[k] = if type(v) == "table" and v.__secret then v.__secret else v
	end
	local captured = { Url = req.Url, Method = req.Method, Headers = headers, Body = req.Body }
	table.insert(__requests, captured)
	task.wait(__httpLatency)
	local res = __httpHandler(captured)
	captured.StatusCode = res.StatusCode
	return { StatusCode = res.StatusCode, Body = res.Body or "", Success = res.StatusCode >= 200 and res.StatusCode < 300, Headers = {} }
end

PlayersMock = { list = {}, PlayerAdded = Signal(), PlayerRemoving = Signal() }
function PlayersMock:GetPlayers()
	local out = {}
	for _, p in pairs(self.list) do
		table.insert(out, p)
	end
	return out
end
function PlayersMock:GetPlayerByUserId(id)
	return self.list[id]
end
function __addPlayer(id, name)
	local p = { UserId = id, Name = name or ("Player" .. tostring(id)) }
	PlayersMock.list[id] = p
	PlayersMock.PlayerAdded:Fire(p)
	return p
end
function __removePlayer(id)
	local p = PlayersMock.list[id]
	PlayersMock.list[id] = nil
	PlayersMock.PlayerRemoving:Fire(p)
end

MarketplaceMock = { PromptGamePassPurchaseFinished = Signal(), __owns = {}, __info = {} }
function MarketplaceMock:UserOwnsGamePassAsync(userId, passId)
	task.wait(0.05)
	return self.__owns[tostring(userId) .. ":" .. tostring(passId)] == true
end
function MarketplaceMock:GetProductInfo(id, infoType)
	task.wait(0.02)
	local info = self.__info[infoType.Name .. ":" .. tostring(id)]
	if not info then
		error("product not found")
	end
	return info
end

RunServiceMock = {}
function RunServiceMock:IsStudio()
	return __studio
end

__stores = {}
DataStoreServiceMock = {}
function DataStoreServiceMock:GetDataStore(name)
	local store = __stores[name]
	if store then
		return store
	end
	store = { data = {} }
	function store:SetAsync(key, value)
		task.wait(0.01)
		self.data[key] = JSON.decode(JSON.encode(value))
	end
	function store:GetAsync(key)
		task.wait(0.01)
		return self.data[key]
	end
	function store:RemoveAsync(key)
		task.wait(0.01)
		self.data[key] = nil
	end
	function store:ListKeysAsync(prefix, _pageSize)
		local keys = {}
		for k in pairs(self.data) do
			if prefix == nil or string.sub(k, 1, #prefix) == prefix then
				table.insert(keys, { KeyName = k })
			end
		end
		return {
			GetCurrentPage = function()
				return keys
			end,
		}
	end
	__stores[name] = store
	return store
end

local ServerScriptServiceMock = {
	WaitForChild = function(_, name)
		return { Name = name }
	end,
}

local services = {
	Players = PlayersMock,
	HttpService = HttpServiceMock,
	MarketplaceService = MarketplaceMock,
	RunService = RunServiceMock,
	DataStoreService = DataStoreServiceMock,
	ServerScriptService = ServerScriptServiceMock,
}

game = { JobId = "11111111-2222-3333-4444-555555555555", GameId = 4242, PlaceId = 111, PlaceVersion = 7, PrivateServerId = "", __close = {} }
function game:GetService(name)
	return services[name] or error("no service " .. name)
end
function game:BindToClose(fn)
	table.insert(self.__close, fn)
end
function __shutdown()
	for _, fn in ipairs(game.__close) do
		task.spawn(fn)
	end
end

local function enumItem(enumName, name)
	return { Name = name, EnumType = enumName }
end
Enum = {
	ProductPurchaseDecision = {
		PurchaseGranted = enumItem("ProductPurchaseDecision", "PurchaseGranted"),
		NotProcessedYet = enumItem("ProductPurchaseDecision", "NotProcessedYet"),
	},
	InfoType = { Product = enumItem("InfoType", "Product"), GamePass = enumItem("InfoType", "GamePass") },
	CurrencyType = { Robux = enumItem("CurrencyType", "Robux") },
}

script = {
	WaitForChild = function(_, name)
		return { Name = name }
	end,
}

require = function(ref)
	local m = __MODULES[ref.Name]
	if m == nil then
		error("module not loaded: " .. tostring(ref.Name))
	end
	return m
end

return true
